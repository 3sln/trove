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
import { newId, isValidItemName } from './util.js';

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
  /**
   * Which sessions have expired — WITHOUT deleting them.
   *
   * Deleting the record here is what leaked: the session holds the S3 `uploadId`, and
   * that is the only handle that can abort the multipart. Drop it and the parts stay in
   * the bucket, billed, with nothing left that could ever reclaim them (the collection
   * scanner deliberately refuses to touch `obj_*` keys). Expiry has to go through
   * UploadManager.sweepExpired, which aborts first and deletes after.
   */
  async expired(now) {
    return [...this.map.entries()].filter(([, s]) => now - s.createdAt > SESSION_TTL_MS).map(([id]) => id);
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
   * @param {{collectionId?:string, name:string, size:number, contentType?:string}} req
   */
  async create(req) {
    if (!isValidItemName(req.name)) throw TroveError.invalid(`Invalid file name "${req.name}"`);
    if (!(req.size >= 0)) throw TroveError.invalid('size must be a non-negative number');
    if (this.maxBytes && req.size > this.maxBytes) {
      // Deterministic per-file limit — retrying can't help, so it's non-retryable
      // (capacity/rate quotas stay retryable via the default).
      // TOO_LARGE (413), not QUOTA: the store has plenty of room, this file is simply
      // bigger than this deployment permits. Reporting it as a capacity problem would
      // send the user looking for space to free that would not help.
      throw TroveError.tooLarge(`File exceeds the maximum upload size of ${this.maxBytes} bytes`, { details: { maxBytes: this.maxBytes, size: req.size } });
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
      name: req.name,
      // Whether the caller asked to replace an existing item of this name. Carried on
      // the session because the decision is made when the upload STARTS but has to be
      // honoured when it COMPLETES, possibly much later.
      overwrite: !!req.overwrite,
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
      const partCount = Math.max(1, Math.ceil(req.size / this.partSize));
      // `#limits()` advertises maxParts in the very same response, and nothing enforced
      // it: a 150 GiB file planned 19,200 parts against a ceiling of 10,000, which S3
      // rejects at part 10,001 — after the client has transferred 80 GiB. On a presign
      // backend it also signed every part up front, so the plan itself came back as a
      // 1.9 MB JSON document. Refuse at negotiation, where it costs nothing.
      if (partCount > MAX_PARTS) {
        throw TroveError.tooLarge(
          `This file needs ${partCount.toLocaleString()} parts of ${this.partSize} bytes, over the ${MAX_PARTS.toLocaleString()}-part limit`,
          { details: { maxParts: MAX_PARTS, partCount, partSize: this.partSize, size: req.size } },
        );
      }
      // Only now open the multipart. Refusing AFTER creating it left an upload open in
      // the bucket with no session record, so nothing could ever abort it.
      session.uploadId = await storage.createMultipart(storageKey, { contentType });
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
    // Same bounds as uploadPart. Unbounded, a client could report hundreds of thousands
    // of out-of-plan parts, all retained for the session's 24h TTL — and `status` hands
    // that list back as the parts it may SKIP.
    if (!Number.isInteger(partNumber) || partNumber < 1 || (s.partCount && partNumber > s.partCount)) {
      throw TroveError.invalid(`Part ${partNumber} is outside this upload's ${s.partCount} part(s)`);
    }
    s.parts[partNumber] = { etag };
    await this.sessions.put(s);
    return { ok: true };
  }

  /** Direct backends: stream one part through us to storage. */
  async uploadPart(uploadId, partNumber, body, opts = {}) {
    const s = await this.#session(uploadId);
    const storage = await this.#storage(s.collectionId);
    if (s.strategy === 'direct-single') {
      // The proxied body is raw bytes streamed straight to storage — the JSON body cap
      // deliberately doesn't apply — so this is the only place a client can be stopped
      // from writing an unbounded object through us.
      const capped = capStream(body, this.maxBytes);
      const info = await storage.put(s.storageKey, capped, { contentType: s.contentType, ...opts });
      s.parts[1] = { etag: info.etag || 'single' };
      await this.sessions.put(s);
      return { partNumber: 1, etag: s.parts[1].etag };
    }
    if (s.strategy !== 'direct') throw TroveError.invalid('uploadPart only applies to direct uploads');
    // A part outside the plan is stored, billed, and never merged — `complete` only
    // walks 1..partCount. Silently accepting one meant a client could believe it had
    // uploaded bytes that would never become part of the file.
    // `NaN < 1` and `NaN > partCount` are BOTH false, so a non-numeric part number
    // walked through and its bytes were written under the key "NaN" — billed, and
    // unmergeable, since `complete` only ever walks 1..partCount.
    if (!Number.isInteger(partNumber) || partNumber < 1 || (s.partCount && partNumber > s.partCount)) {
      throw TroveError.invalid(`Part ${partNumber} is outside this upload's ${s.partCount} part(s)`);
    }
    // A part is exactly `partSize` bytes, except the last, which is smaller.
    const res = await storage.putPart(s.storageKey, s.uploadId, partNumber, capStream(body, s.partSize), opts);
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
      collectionId: s.collectionId,
      strategy: s.strategy,
      partCount: s.partCount ?? 1,
      partSize: s.partSize,
      received,
    };
  }

  /**
   * Finalise. Verifies all parts are present, completes multipart, and returns
   * the object descriptor so the VFS can create the node.
   * @returns {Promise<{storageKey, size, contentType, etag, collectionId, name}>}
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
    // What actually landed, not what the client said it would send.
    //
    // `size` up to here has been the client's DECLARED size — the value the per-file
    // limit was checked against at create(). Nothing re-checked the bytes, so declaring
    // `size: 1` and then PUTting gigabytes walked straight past the limit and recorded a
    // size that was simply false (which the quota meter, the UI and every later
    // range read then believed). Ask the store.
    const storage = await this.#storage(s.collectionId);
    let size = s.size;
    try {
      const info = await storage.head(s.storageKey);
      if (Number.isFinite(info?.size)) size = info.size;
    } catch (err) {
      // NOT_FOUND is the one error that means something specific: no bytes were ever
      // stored. Swallowing it committed an item for an object that does not exist — the
      // drive listing a file whose size is a number the client invented, whose download
      // redirects to a 404, and which every indexer then raises a standing issue about.
      // Reachable whenever a presigned PUT fails but `complete` still runs.
      if (err?.code === ErrorCode.NOT_FOUND) {
        await this.sessions.delete(uploadId);
        throw TroveError.invalid('The upload was never written — no object exists for this session');
      }
      // Any other failure (a backend that can't answer a HEAD) leaves the declared size
      // in place; better an approximate record than refusing an upload that succeeded.
    }
    if (this.maxBytes && size > this.maxBytes) {
      // It is already in the store, so let it go rather than leaving an orphan that
      // counts against the quota and belongs to nothing.
      await storage.delete(s.storageKey).catch(() => {});
      await this.sessions.delete(uploadId);
      throw TroveError.tooLarge(
        `File exceeds the maximum upload size of ${this.maxBytes} bytes`,
        { details: { maxBytes: this.maxBytes, size } },
      );
    }
    await this.sessions.delete(uploadId);
    return {
      storageKey: s.storageKey,
      size,
      contentType: s.contentType,
      etag,
      collectionId: s.collectionId,
      name: s.name,
      overwrite: !!s.overwrite,
    };
  }

  /**
   * Reclaim uploads the client started and never finished.
   *
   * A dropped connection, a closed tab, a crash — all leave a live multipart upload
   * whose parts are stored and billed until something aborts them. That something is
   * this: it goes through `abort`, which tells the backend to let the parts go before
   * the session record (and with it the uploadId) is discarded.
   *
   * @returns {Promise<{aborted: number, failed: number}>}
   */
  async sweepExpired(now = Date.now()) {
    const ids = (await this.sessions.expired?.(now)) || [];
    let aborted = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await this.abort(id);
        aborted++;
      } catch (err) {
        // Leave the session in place so the next sweep tries again — dropping it is
        // exactly how the bytes became unreclaimable in the first place.
        failed++;
        console.error(`[trove] could not reclaim abandoned upload ${id}:`, err?.message || err);
      }
    }
    return { aborted, failed };
  }

  async abort(uploadId) {
    const s = await this.sessions.get(uploadId);
    if (!s) return;
    const storage = await this.#storage(s.collectionId);
    // The session record holds the multipart uploadId, and that is the ONLY handle that
    // can ever reclaim the staged parts. Swallowing the backend's failure and deleting
    // the record anyway is precisely how the bytes became unreclaimable — and it made
    // sweepExpired's failure branch, whose comment says exactly that, unreachable.
    if (s.uploadId) await storage.abortMultipart(s.storageKey, s.uploadId);
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

/**
 * Wrap a streamed body so it cannot exceed `max` bytes.
 *
 * Uploads bypass the JSON body cap by design — their bytes stream to storage rather
 * than being buffered — which left the proxied part route with no ceiling at all: the
 * declared size was checked at create() and nothing checked what actually arrived.
 * Non-stream bodies (a Uint8Array from a test, a Blob) pass through untouched; they are
 * already resident, so capping them here would not save the memory.
 */
function capStream(body, max) {
  if (!max || !body || typeof body.getReader !== 'function') return body;
  const reader = body.getReader();
  let total = 0;
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        controller.error(TroveError.tooLarge(`Upload body exceeds ${max} bytes`, { details: { maxBytes: max } }));
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) { reader.cancel(reason).catch(() => {}); },
  });
}
