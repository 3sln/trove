// In-memory storage backend. The reference implementation and the one tests run
// against — it exercises the full contract (multipart, ranges) without touching
// disk or the network. Not for production (everything lives in a Map), but it
// keeps the higher layers honest.

import { StorageBackend, toBytes, bytesStream, concat } from './interface.js';
import { TroveError } from '../errors.js';

function etagOf(bytes) {
  // Cheap non-cryptographic content tag; good enough to detect changes.
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return `"${(h >>> 0).toString(16)}-${bytes.length}"`;
}

export class MemoryStorage extends StorageBackend {
  constructor() {
    super();
    this.objects = new Map(); // key -> { bytes, contentType, etag }
    this.uploads = new Map(); // uploadId -> { key, contentType, parts: Map<number, bytes> }
  }

  get capabilities() {
    return { presignDownload: false, presignUpload: false, multipart: true, range: true, list: true };
  }

  async list({ prefix = '', cursor = null, limit = 1000 } = {}) {
    // Sorted so the cursor (the last key returned) is a stable resume point.
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? keys.findIndex((k) => k > cursor) : 0;
    const from = start === -1 ? keys.length : start;
    const page = keys.slice(from, from + limit);
    return {
      objects: page.map((key) => {
        const o = this.objects.get(key);
        return { key, size: o.bytes.length, etag: o.etag, modifiedAt: o.modifiedAt ?? null };
      }),
      nextCursor: from + limit < keys.length ? page[page.length - 1] : null,
    };
  }

  async put(key, body, opts = {}) {
    const bytes = await toBytes(body);
    if (opts.signal?.aborted) throw TroveError.aborted();
    const rec = { bytes, contentType: opts.contentType, etag: etagOf(bytes), modifiedAt: Date.now() };
    this.objects.set(key, rec);
    opts.onProgress?.(bytes.length);
    return { size: bytes.length, contentType: rec.contentType, etag: rec.etag };
  }

  async head(key) {
    const rec = this.objects.get(key);
    if (!rec) throw TroveError.notFound('Object');
    return { size: rec.bytes.length, contentType: rec.contentType, etag: rec.etag };
  }

  async get(key, opts = {}) {
    const rec = this.objects.get(key);
    if (!rec) throw TroveError.notFound('Object');
    const total = rec.bytes.length;
    let range;
    if (opts.range) {
      const start = opts.range.start ?? 0;
      const end = opts.range.end != null ? Math.min(opts.range.end, total - 1) : total - 1;
      if (start > end || start >= total) throw TroveError.invalid('Range not satisfiable');
      range = { start, end, total };
    }
    return {
      stream: bytesStream(rec.bytes, range && { start: range.start, end: range.end }),
      size: range ? range.end - range.start + 1 : total,
      contentType: rec.contentType,
      etag: rec.etag,
      range,
    };
  }

  async delete(key) {
    this.objects.delete(key);
  }

  // --- multipart (direct part upload) ---------------------------------------

  async createMultipart(key, opts = {}) {
    const uploadId = `mem-${Math.random().toString(36).slice(2)}`;
    this.uploads.set(uploadId, { key, contentType: opts.contentType, parts: new Map() });
    return uploadId;
  }

  async putPart(key, uploadId, partNumber, body) {
    const up = this.uploads.get(uploadId);
    if (!up) throw TroveError.notFound('Upload');
    const bytes = await toBytes(body);
    up.parts.set(partNumber, bytes);
    return { partNumber, etag: etagOf(bytes) };
  }

  async completeMultipart(key, uploadId, parts) {
    const up = this.uploads.get(uploadId);
    if (!up) throw TroveError.notFound('Upload');
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const chunks = ordered.map((p) => {
      const b = up.parts.get(p.partNumber);
      if (!b) throw TroveError.invalid(`Missing part ${p.partNumber}`);
      return b;
    });
    const bytes = concat(chunks);
    const rec = { bytes, contentType: up.contentType, etag: etagOf(bytes), modifiedAt: Date.now() };
    this.objects.set(key, rec);
    this.uploads.delete(uploadId);
    return { size: bytes.length, etag: rec.etag };
  }

  async abortMultipart(key, uploadId) {
    this.uploads.delete(uploadId);
  }
}
