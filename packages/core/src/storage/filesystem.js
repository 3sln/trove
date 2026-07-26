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
import { StorageBackend } from './interface.js';
import { TroveError, wrapError } from '../errors.js';
import { newId } from '../util.js';

function shardPath(root, key) {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
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
    return { presignDownload: false, presignUpload: false, multipart: true, range: true, list: true };
  }

  async #ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
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
      // The name IS the key only when it round-trips through the shard mapping.
      if (shardPath(this.root, d.name) !== full) { unaddressable++; continue; }
      if (prefix && !d.name.startsWith(prefix)) continue;
      entries.push({ key: d.name, full });
    }
    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const start = cursor ? entries.findIndex((e) => e.key > cursor) : 0;
    const from = start === -1 ? entries.length : start;
    const page = entries.slice(from, from + limit);
    const objects = [];
    for (const e of page) {
      try {
        const st = await fs.stat(e.full);
        objects.push({ key: e.key, size: st.size, etag: `"${st.size}-${Math.floor(st.mtimeMs)}"`, modifiedAt: Math.floor(st.mtimeMs) });
      } catch { /* vanished mid-walk; the next scan will see it */ }
    }
    return {
      objects,
      nextCursor: from + limit < entries.length ? page[page.length - 1].key : null,
      unaddressable,
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
    let range;
    let streamOpts = {};
    if (opts.range) {
      const start = opts.range.start ?? 0;
      const end = opts.range.end != null ? Math.min(opts.range.end, total - 1) : total - 1;
      if (start > end || start >= total) throw TroveError.invalid('Range not satisfiable');
      range = { start, end, total };
      streamOpts = { start, end };
    }
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
