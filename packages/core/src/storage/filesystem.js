// Filesystem storage backend (Node). Also the "NAS" backend — point `root` at a
// mounted network share. Stores each object as a file under a two-level sharded
// directory (ab/cd/<key>) to avoid huge flat directories. Supports range reads
// (media seeking, resumable downloads); no presigning, so the server proxies
// bytes for these backends. Multipart is emulated with per-part temp files that
// are concatenated on complete — writes are staged to a temp file and atomically
// renamed so a crash mid-write never yields a half-written object.

import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StorageBackend, resolveRange } from './interface.js';
import { TroveError, wrapError } from '../errors.js';
import { newId } from '../util.js';

// A key becomes a filename, so anything a filename can't hold has to be encoded —
// REVERSIBLY. Replacing every disallowed character with `_` was not: `list()` could only
// ever report the mangled name back, so a collection using bucket-and-prefix over a
// filesystem (keys like `team-a/obj_9f…`) listed nothing at all, adopt and refresh
// silently never ran, and every one of its items came back as an orphan — a durable
// "your files are gone" warning on a drive where nothing was wrong.
//
// `~XX` over UTF-8 bytes, with `~` itself encoded, so decoding is exact. Keys made only
// of safe characters — which is every key Trove mints (`obj_<hex>`) — encode to
// themselves, so this changes no existing filename.
function encodeKey(key) {
  let out = '';
  for (const byte of new TextEncoder().encode(key)) {
    const c = String.fromCharCode(byte);
    out += /[a-zA-Z0-9._-]/.test(c) ? c : '~' + byte.toString(16).padStart(2, '0');
  }
  return out;
}
function decodeKey(name) {
  const bytes = [];
  for (let i = 0; i < name.length; i++) {
    if (name[i] === '~' && /^[0-9a-f]{2}$/i.test(name.slice(i + 1, i + 3))) {
      bytes.push(parseInt(name.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(name.charCodeAt(i) & 0xff);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function shardPath(root, key) {
  const safe = encodeKey(key);
  const a = (safe.slice(0, 2) || '__').padEnd(2, '_');
  const b = (safe.slice(2, 4) || '__').padEnd(2, '_');
  return path.join(root, 'objects', a, b, safe);
}

async function toNodeStream(body) {
  if (body instanceof Readable) return body;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    return Readable.from(Buffer.from(body instanceof ArrayBuffer ? new Uint8Array(body) : body));
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return Readable.fromWeb(body.stream());
  }
  if (body instanceof ReadableStream || typeof body?.getReader === 'function') {
    return Readable.fromWeb(body);
  }
  if (typeof body?.[Symbol.asyncIterator] === 'function') return Readable.from(body);
  if (typeof body === 'string') return Readable.from(Buffer.from(body));
  throw TroveError.invalid('Unsupported body type');
}

export class FilesystemStorage extends StorageBackend {
  /** @param {{root: string}} opts */
  constructor({ root }) {
    super();
    if (!root) throw TroveError.invalid('FilesystemStorage requires a root directory');
    this.root = path.resolve(root);
    this.tmp = path.join(this.root, 'tmp');
  }

  get capabilities() {
    return { presignDownload: false, presignUpload: false, multipart: true, range: true, list: true, usage: true };
  }

  async #ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
  }

  /**
   * Space on the filesystem holding this root.
   *
   * Reports the FILESYSTEM's numbers, not the drive's — if Trove shares a disk with
   * everything else on the machine, "12 GB free" is the fact that actually governs
   * whether the next upload succeeds, and reporting only Trove's own footprint would
   * leave someone confident with a full disk. `bavail` (free to a non-root user), not
   * `bfree`, for the same reason: the reserved blocks are not available to us.
   */
  async usage() {
    // statfs needs a path that EXISTS, and the root is created lazily on first write —
    // so asking before anything has been uploaded would report "unknown" on exactly the
    // empty drive where someone is most likely to be checking. Walk up to the nearest
    // existing ancestor; it is on the same filesystem, which is what we are measuring.
    let dir = this.root;
    for (let i = 0; i < 8; i++) {
      try {
        const st = await fs.statfs(dir);
        const total = st.blocks * st.bsize;
        const available = st.bavail * st.bsize;
        return { total, available, used: total - available };
      } catch (err) {
        if (err?.code !== 'ENOENT') return null; // old runtime, exotic mount: don't guess
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
      }
    }
    return null;
  }

  /**
   * Walk the object tree so a scan can see files that arrived without Trove.
   *
   * Keys here are shard-mapped through a LOSSY sanitizer, so the mapping is only
   * reversible for keys that survive it unchanged — which every key Trove writes does
   * (`obj_<hex>`), and a hand-dropped `My Photo.jpg` does not. Rather than guess, this
   * reports only files sitting at the exact path their own name maps to, and counts the
   * rest as `unaddressable` so the caller can say so out loud instead of silently
   * ignoring them.
   */
  async list({ prefix = '', cursor = null, limit = 1000 } = {}) {
    const base = path.join(this.root, 'objects');
    let found;
    try {
      found = await fs.readdir(base, { recursive: true, withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return { objects: [], nextCursor: null, unaddressable: 0 };
      throw wrapError(err);
    }
    const entries = [];
    let unaddressable = 0;
    for (const d of found) {
      if (!d.isFile()) continue;
      const full = path.join(d.parentPath || d.path, d.name);
      // Decode back to the real key first — the filename is an encoding of it, and the
      // prefix a caller filters on is expressed in key space, not filename space.
      const key = decodeKey(d.name);
      // It is addressable only if it round-trips: a file dropped into the shard tree by
      // hand, or left by an older layout, doesn't map back to a key we can serve.
      if (shardPath(this.root, key) !== full) { unaddressable++; continue; }
      if (prefix && !key.startsWith(prefix)) continue;
      entries.push({ key, full });
    }
    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const start = cursor ? entries.findIndex((e) => e.key > cursor) : 0;
    const from = start === -1 ? entries.length : start;
    const page = entries.slice(from, from + limit);
    const objects = [];
    for (const e of page) {
      try {
        const st = await fs.stat(e.full);
        // etagOfStat, NOT a second hand-rolled format. An etag only means anything if
        // it is computed identically everywhere: this listing is compared against the
        // etag `put` recorded, and a different encoding of the same facts made every
        // object look changed — a scan that re-read and re-indexed the entire drive.
        objects.push({ key: e.key, size: st.size, etag: etagOfStat(st), modifiedAt: Math.floor(st.mtimeMs) });
      } catch { /* vanished mid-walk; the next scan will see it */ }
    }
    return {
      objects,
      nextCursor: from + limit < entries.length ? page[page.length - 1].key : null,
      // A figure about the WHOLE tree, so it is reported once — on the first page only.
      // Returning it on every page made a caller that sums pages multiply it by the page
      // count: one stray file in a 3,000-object drive was reported as seven.
      ...(cursor ? {} : { unaddressable }),
    };
  }

  async put(key, body, opts = {}) {
    const dest = shardPath(this.root, key);
    await this.#ensureDir(path.dirname(dest));
    await this.#ensureDir(this.tmp);
    const tmpFile = path.join(this.tmp, newId('put'));
    let written = 0;
    try {
      const src = await toNodeStream(body);
      if (opts.onProgress) {
        src.on('data', (c) => {
          written += c.length;
          opts.onProgress(written);
        });
      }
      const out = createWriteStream(tmpFile);
      await pipeline(src, out, { signal: opts.signal });
      await fs.rename(tmpFile, dest); // atomic within a filesystem
    } catch (err) {
      await fs.rm(tmpFile, { force: true }).catch(() => {});
      throw wrapError(err);
    }
    const stat = await fs.stat(dest);
    return { size: stat.size, contentType: opts.contentType, etag: etagOfStat(stat) };
  }

  async head(key) {
    try {
      const stat = await fs.stat(shardPath(this.root, key));
      return { size: stat.size, etag: etagOfStat(stat) };
    } catch (err) {
      throw wrapError(err);
    }
  }

  async get(key, opts = {}) {
    const file = shardPath(this.root, key);
    let stat;
    try {
      stat = await fs.stat(file);
    } catch (err) {
      throw wrapError(err);
    }
    const total = stat.size;
    const range = resolveRange(opts.range, total);
    const streamOpts = range ? { start: range.start, end: range.end } : {};
    const nodeStream = createReadStream(file, { ...streamOpts, signal: opts.signal });
    return {
      stream: Readable.toWeb(nodeStream),
      size: range ? range.end - range.start + 1 : total,
      etag: etagOfStat(stat),
      range,
    };
  }

  async delete(key) {
    await fs.rm(shardPath(this.root, key), { force: true });
  }

  // --- multipart (staged part files, concatenated on complete) --------------

  async createMultipart(key) {
    const uploadId = newId('mp');
    await this.#ensureDir(path.join(this.tmp, uploadId));
    return uploadId;
  }

  async putPart(key, uploadId, partNumber, body, opts = {}) {
    const partFile = path.join(this.tmp, uploadId, String(partNumber));
    const src = await toNodeStream(body);
    await pipeline(src, createWriteStream(partFile), { signal: opts.signal });
    const stat = await fs.stat(partFile);
    return { partNumber, etag: etagOfStat(stat) };
  }

  async completeMultipart(key, uploadId, parts) {
    const dir = path.join(this.tmp, uploadId);
    const dest = shardPath(this.root, key);
    await this.#ensureDir(path.dirname(dest));
    const tmpFile = path.join(this.tmp, newId('complete'));
    const out = createWriteStream(tmpFile);
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    try {
      for (const p of ordered) {
        const partFile = path.join(dir, String(p.partNumber));
        await pipeline(createReadStream(partFile), out, { end: false });
      }
      out.end();
      await new Promise((res, rej) => out.on('finish', res).on('error', rej));
      await fs.rename(tmpFile, dest);
    } catch (err) {
      await fs.rm(tmpFile, { force: true }).catch(() => {});
      throw wrapError(err);
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    const stat = await fs.stat(dest);
    return { size: stat.size, etag: etagOfStat(stat) };
  }

  async abortMultipart(key, uploadId) {
    await fs.rm(path.join(this.tmp, uploadId), { recursive: true, force: true }).catch(() => {});
  }
}

function etagOfStat(stat) {
  return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

/**
 * This driver as a registrable descriptor.
 *
 * Deliberately exported from HERE and not from the package barrel or drivers.js. Importing
 * it is what pulls node:fs into a bundle, so a Workers entry point that never mentions it
 * gets neither the form option nor the module — which is also why `core/index.js` no
 * longer re-exports FilesystemStorage. A Workers build previously needed nodejs_compat
 * purely because the barrel dragged this file in whether or not it could ever be used.
 */
export function filesystemDriver() {
  return {
    key: 'filesystem',
    label: 'Filesystem / NAS',
    description: 'A directory on this machine, or a mounted network share.',
    fields: [
      { name: 'root', label: 'Root directory', required: true, placeholder: './data/team' },
      { name: 'prefix', label: 'Prefix', help: 'Share one directory between collections.' },
    ],
    create: (cfg) => new FilesystemStorage({ root: cfg.root }),
  };
}
