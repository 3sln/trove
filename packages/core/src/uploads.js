// UploadManager — resumable, large-file uploads with a strategy chosen from the
// backend's capabilities:
//   - 'single'  : one presigned PUT (small files on a presign-capable backend).
//   - 'presign' : multipart with a presigned URL per part — the client uploads
//                 parts straight to S3, we never see the bytes. The client
//                 reports each part's ETag back so we can complete.
//   - 'direct'  : multipart where each part is PUT to *our* server, which streams
//                 it to storage (filesystem/NAS/memory that can't presign).
//
// Sessions are held in a pluggable store (in-memory by default) so an upload can
// resume after a dropped connection: the client re-lists parts, re-requests any
// missing signed URL, and continues. `create` never allocates a node; the node
// appears only on `complete`, so a half-finished upload leaves no ghost files.

import { TroveError, ErrorCode } from './errors.js';
import { newId, isValidName } from './util.js';

export const DEFAULT_PART_SIZE = 8 * 1024 * 1024; // 8 MiB
const MIN_MULTIPART_PART = 5 * 1024 * 1024; // S3 floor (except final part)
const SINGLE_PUT_LIMIT = 5 * 1024 * 1024; // below this, one PUT beats multipart
const MAX_PARTS = 10_000; // S3 multipart ceiling
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

class MemorySessionStore {
  constructor() {
    this.map = new Map();
  }
  async get(id) {
    return this.map.get(id) || null;
  }
  async put(session) {
    this.map.set(session.id, session);
  }
  async delete(id) {
    this.map.delete(id);
  }
  async sweep(now) {
    for (const [id, s] of this.map) if (now - s.createdAt > SESSION_TTL_MS) this.map.delete(id);
  }
}

export class UploadManager {
  /**
   * @param {object} deps
   * @param {import('./storage/interface.js').StorageBackend} deps.storage
   * @param {object} [deps.sessions] session store (defaults in-memory)
   * @param {number} [deps.partSize]
   */
  constructor({ storage, storageFor, sessions, partSize = DEFAULT_PART_SIZE, maxBytes = null }) {
    // Either a single backend, or a resolver keyed by collectionId (collections).
    this.storageFor = storageFor ?? (async () => storage);
    this.sessions = sessions ?? new MemorySessionStore();
    this.partSize = partSize;
    this.maxBytes = maxBytes || null; // per-file quota (null = unbounded)
  }

  // The self-describing limits the client gets back in every upload descriptor.
  #limits() {
    return {
      maxBytes: this.maxBytes,          // per-file quota (null = unbounded)
      partSize: this.partSize,
      minPartSize: MIN_MULTIPART_PART,  // multipart floor, except the final part
      singlePutLimit: SINGLE_PUT_LIMIT, // at/under this we use one PUT, not multipart
      maxParts: MAX_PARTS,
    };
  }

  #storage(collectionId) {
    return this.storageFor(collectionId);
  }

  /**
   * Begin an upload. Returns a plan the client follows.
   * @param {{parentId:string, name:string, size:number, contentType?:string}} req
   */
  async create(req) {
    if (!isValidName(req.name)) throw TroveError.invalid(`Invalid file name "${req.name}"`);
    if (!(req.size >= 0)) throw TroveError.invalid('size must be a non-negative number');
    if (this.maxBytes && req.size > this.maxBytes) {
      // Deterministic per-file limit — retrying can't help, so it's non-retryable
      // (capacity/rate quotas stay retryable via the default).
      throw new TroveError(ErrorCode.QUOTA, `File exceeds the maximum upload size of ${this.maxBytes} bytes`, { retryable: false, details: { maxBytes: this.maxBytes, size: req.size } });
    }
    const collectionId = req.collectionId || 'default';
    const storage = await this.#storage(collectionId);
    const caps = storage.capabilities;
    const storageKey = newId('obj');
    const contentType = req.contentType || 'application/octet-stream';

    const session = {
      id: newId('up'),
      storageKey,
      collectionId,
      parentId: req.parentId,
      name: req.name,
      size: req.size,
      contentType,
      createdAt: Date.now(),
      strategy: null,
      partSize: this.partSize,
      uploadId: null,
      parts: {}, // partNumber -> { etag }
    };

    const limits = this.#limits();

    // Small file + presign → single PUT straight to storage (never through us).
    if (req.size <= SINGLE_PUT_LIMIT && caps.presignUpload) {
      session.strategy = 'single';
      await this.sessions.put(session);
      const url = await storage.presignPut(storageKey, { contentType });
      return { ...planSummary(session), strategy: 'single', multipart: false, presigned: true, url, limits };
    }

    // Multipart (presigned parts straight to storage, or streamed through us).
    if (caps.multipart) {
      session.strategy = caps.presignUpload ? 'presign' : 'direct';
      session.uploadId = await storage.createMultipart(storageKey, { contentType });
      const partCount = Math.max(1, Math.ceil(req.size / this.partSize));
      session.partCount = partCount;
      await this.sessions.put(session);
      const parts = [];
      if (session.strategy === 'presign') {
        for (let n = 1; n <= partCount; n++) {
          parts.push({ partNumber: n, url: await storage.presignPart(storageKey, session.uploadId, n) });
        }
      }
      return { ...planSummary(session), strategy: session.strategy, multipart: true, presigned: session.strategy === 'presign', partCount, parts, limits };
    }

    // Fallback: whole-object PUT streamed through us (tiny/simple backends).
    session.strategy = 'direct-single';
    await this.sessions.put(session);
    return { ...planSummary(session), strategy: 'direct-single', multipart: false, presigned: false, limits };
  }

  /** Re-issue a signed URL for one part (resume after expiry). */
  async signPart(uploadId, partNumber) {
    const s = await this.#session(uploadId);
    if (s.strategy !== 'presign') throw TroveError.invalid('signPart only applies to presigned uploads');
    const storage = await this.#storage(s.collectionId);
    return storage.presignPart(s.storageKey, s.uploadId, partNumber);
  }

  /** Client reports a completed presigned part (with its ETag from S3). */
  async reportPart(uploadId, partNumber, etag) {
    const s = await this.#session(uploadId);
    if (!etag) throw TroveError.invalid('Part ETag required');
    s.parts[partNumber] = { etag };
    await this.sessions.put(s);
    return { ok: true };
  }

  /** Direct backends: stream one part through us to storage. */
  async uploadPart(uploadId, partNumber, body, opts = {}) {
    const s = await this.#session(uploadId);
    const storage = await this.#storage(s.collectionId);
    if (s.strategy === 'direct-single') {
      const info = await storage.put(s.storageKey, body, { contentType: s.contentType, ...opts });
      s.parts[1] = { etag: info.etag || 'single' };
      await this.sessions.put(s);
      return { partNumber: 1, etag: s.parts[1].etag };
    }
    if (s.strategy !== 'direct') throw TroveError.invalid('uploadPart only applies to direct uploads');
    const res = await storage.putPart(s.storageKey, s.uploadId, partNumber, body, opts);
    s.parts[partNumber] = { etag: res.etag };
    await this.sessions.put(s);
    return res;
  }

  /** Which parts are still outstanding (resume support). */
  async status(uploadId) {
    const s = await this.#session(uploadId);
    const received = Object.keys(s.parts).map(Number).sort((a, b) => a - b);
    return {
      uploadId,
      strategy: s.strategy,
      partCount: s.partCount ?? 1,
      partSize: s.partSize,
      received,
    };
  }

  /**
   * Finalise. Verifies all parts are present, completes multipart, and returns
   * the object descriptor so the VFS can create the node.
   * @returns {Promise<{storageKey, size, contentType, etag, parentId, name}>}
   */
  async complete(uploadId, reportedParts) {
    const s = await this.#session(uploadId);
    let etag;
    if (s.strategy === 'single' || s.strategy === 'direct-single') {
      // Object already fully written by the client (single presigned PUT) or by us.
      etag = s.parts[1]?.etag;
    } else {
      // Merge any client-reported ETags (presign) with what we recorded.
      const parts = [];
      const count = s.partCount ?? Object.keys(s.parts).length;
      for (let n = 1; n <= count; n++) {
        const fromClient = reportedParts?.find((p) => p.partNumber === n);
        const etagN = fromClient?.etag || s.parts[n]?.etag;
        if (!etagN) {
          throw TroveError.invalid(`Missing part ${n} of ${count}`, { details: { partNumber: n } });
        }
        parts.push({ partNumber: n, etag: etagN });
      }
      const storage = await this.#storage(s.collectionId);
      const res = await storage.completeMultipart(s.storageKey, s.uploadId, parts);
      etag = res.etag;
    }
    await this.sessions.delete(uploadId);
    return {
      storageKey: s.storageKey,
      size: s.size,
      contentType: s.contentType,
      etag,
      collectionId: s.collectionId,
      parentId: s.parentId,
      name: s.name,
    };
  }

  async abort(uploadId) {
    const s = await this.sessions.get(uploadId);
    if (!s) return;
    const storage = await this.#storage(s.collectionId);
    if (s.uploadId) await storage.abortMultipart(s.storageKey, s.uploadId).catch(() => {});
    else await storage.delete(s.storageKey).catch(() => {});
    await this.sessions.delete(uploadId);
  }

  async #session(uploadId) {
    const s = await this.sessions.get(uploadId);
    if (!s) throw TroveError.notFound('Upload session');
    return s;
  }
}

function planSummary(s) {
  return { uploadId: s.id, storageKey: s.storageKey, partSize: s.partSize, size: s.size, name: s.name, contentType: s.contentType };
}
