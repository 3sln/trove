// StorageBackend — the pluggable blob store contract.
//
// A backend stores opaque byte blobs addressed by a *storage key* (an internal
// id, NOT the user-visible path — the VFS/metadata layer owns the path↔key map,
// so rename/move is a metadata edit and never copies bytes).
//
// Backends advertise `capabilities` so higher layers degrade gracefully:
//   - presignDownload/presignUpload: hand the client a direct, time-limited URL
//     (S3) so big transfers bypass our server entirely.
//   - multipart: parallel, resumable multi-part uploads.
//   - range: byte-range reads (needed for media seeking / resumable downloads).
// A backend that lacks presigning (filesystem, memory) still works — the server
// proxies the bytes instead.
//
// Every method that can fail must throw a TroveError (use wrapError at the
// boundary). Every long operation must honour an AbortSignal in `opts.signal`.

import { TroveError } from '../errors.js';
import { readAll, concatBytes } from '../util.js';

// Re-exported for storage backends (memory.js) that assemble chunks themselves.
export { concatBytes as concat };

/**
 * @typedef {object} StorageCapabilities
 * @property {boolean} presignDownload
 * @property {boolean} presignUpload   single-shot PUT via signed URL
 * @property {boolean} multipart       parallel multipart uploads
 * @property {boolean} range           byte-range GET
 * @property {boolean} list            can enumerate what the store actually holds
 * @property {boolean} usage           can report how much space is left
 */

/**
 * @typedef {object} ObjectInfo
 * @property {number} size
 * @property {string} [contentType]
 * @property {string} [etag]
 */

export class StorageBackend {
  /** @type {StorageCapabilities} */
  get capabilities() {
    return { presignDownload: false, presignUpload: false, multipart: false, range: false, list: false, usage: false };
  }

  /**
   * Store a whole object.
   * @param {string} key
   * @param {ReadableStream|Uint8Array|Blob|ArrayBuffer} body
   * @param {{size?: number, contentType?: string, signal?: AbortSignal, onProgress?: (n:number)=>void}} [opts]
   * @returns {Promise<ObjectInfo>}
   */
  async put(key, body, opts) {
    throw TroveError.unsupported('put not implemented');
  }

  /**
   * Read an object (optionally a byte range).
   * @param {string} key
   * @param {{range?: {start:number, end?:number}, signal?: AbortSignal}} [opts]
   * @returns {Promise<{stream: ReadableStream, size: number, contentType?: string, etag?: string, range?: {start:number,end:number,total:number}}>}
   */
  async get(key, opts) {
    throw TroveError.unsupported('get not implemented');
  }

  /** @returns {Promise<ObjectInfo>} throws NOT_FOUND if absent. */
  async head(key) {
    throw TroveError.unsupported('head not implemented');
  }

  /** @param {{signal?: AbortSignal}} [opts] */
  async delete(key, opts) {
    throw TroveError.unsupported('delete not implemented');
  }

  /**
   * Page through the objects actually present in the store.
   *
   * Everything else here addresses a key the caller already knows. This is the one
   * operation that asks the store what it HAS — which is what makes it possible to
   * notice things that happened without Trove: a file dropped in the bucket by
   * another tool, an object deleted out from under an item, bytes replaced in place.
   * Without it the drive can only ever know what it did itself.
   *
   * Paged with an opaque cursor rather than returning everything, because a real
   * bucket does not fit in memory. `capabilities.list` says whether a backend can
   * answer at all.
   *
   * @param {{prefix?: string, cursor?: string|null, limit?: number, signal?: AbortSignal}} [opts]
   * @returns {Promise<{objects: Array<{key: string, size: number, etag?: string, modifiedAt?: number}>, nextCursor: string|null}>}
   */
  async list(opts) {
    throw TroveError.unsupported('list not implemented');
  }

  /**
   * How much room is left.
   *
   * Only some backends can answer. A filesystem or a NAS mount knows exactly, and that
   * is the case where it matters most: a disk fills up and every upload starts failing
   * with no warning that anything was coming. An object store has no such number — S3
   * is effectively unbounded and a bucket quota, if any, lives outside the API — so it
   * returns null rather than inventing one. `capabilities.usage` says which you're
   * dealing with, so a UI can show a real gauge or say nothing at all instead of
   * displaying a meter that means nothing.
   *
   * @returns {Promise<{used: number, available: number, total: number}|null>}
   */
  async usage() {
    return null;
  }

  // --- Optional: presigned direct access (S3) --------------------------------

  /** @returns {Promise<string>} a URL the client GETs directly. */
  async presignGet(key, opts) {
    throw TroveError.unsupported('This backend cannot presign downloads');
  }
  /** @returns {Promise<string>} a URL the client PUTs a whole object to. */
  async presignPut(key, opts) {
    throw TroveError.unsupported('This backend cannot presign uploads');
  }

  // --- Optional: multipart (S3) ----------------------------------------------

  /** @returns {Promise<string>} uploadId */
  async createMultipart(key, opts) {
    throw TroveError.unsupported('This backend does not support multipart uploads');
  }
  /** @returns {Promise<string>} a signed URL to PUT one part to. */
  async presignPart(key, uploadId, partNumber, opts) {
    throw TroveError.unsupported('This backend does not support multipart uploads');
  }
  /**
   * Upload one part directly (non-presign backends).
   * @returns {Promise<{partNumber:number, etag:string}>}
   */
  async putPart(key, uploadId, partNumber, body, opts) {
    throw TroveError.unsupported('This backend does not support multipart uploads');
  }
  /** @param {{partNumber:number, etag:string}[]} parts */
  async completeMultipart(key, uploadId, parts, opts) {
    throw TroveError.unsupported('This backend does not support multipart uploads');
  }
  async abortMultipart(key, uploadId, opts) {
    throw TroveError.unsupported('This backend does not support multipart uploads');
  }
}

/** Coerce assorted body types into a Uint8Array (used by simple backends). */
export async function toBytes(body) {
  if (body == null) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof ReadableStream || typeof body?.getReader === 'function') {
    return await readAll(body);
  }
  // Async iterable (Node stream)
  if (typeof body?.[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const c of body) chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c));
    return concatBytes(chunks);
  }
  throw TroveError.invalid('Unsupported body type');
}

/**
 * Resolve a requested byte range against an object's real size.
 *
 * Two cases the per-backend copies of this arithmetic each got wrong:
 *
 * The SUFFIX form — `bytes=-500` means "the last 500 bytes" (RFC 9110 §14.1.4), and
 * media players and container-footer probes send it routinely. Read as `{start: 0}`
 * it served the FRONT of the file under a 206 that claimed to be what was asked for,
 * which a client has no way to detect.
 *
 * An EMPTY object is deliberately not treated as unsatisfiable. A 0-byte file is a
 * real file, and `end = total - 1 = -1` made every one of them throw: permanently
 * un-indexable (a standing issue whose Retry re-runs the same failure) and unopenable
 * in the text viewer, which reads through a range. The whole of it is zero bytes, so
 * that is what we serve.
 *
 * @returns {{start:number,end:number,total:number}|null} null → serve the whole object
 */
export function resolveRange(range, total) {
  if (!range || total === 0) return null;
  let start;
  let end;
  if (range.suffix != null) {
    const n = Math.min(range.suffix, total);
    if (n <= 0) throw TroveError.invalid('Range not satisfiable');
    start = total - n;
    end = total - 1;
  } else {
    start = range.start ?? 0;
    end = range.end != null ? Math.min(range.end, total - 1) : total - 1;
  }
  if (start < 0 || start > end || start >= total) throw TroveError.invalid('Range not satisfiable');
  return { start, end, total };
}

/** A ReadableStream over an in-memory byte array (with optional range). */
export function bytesStream(bytes, range) {
  const start = range?.start ?? 0;
  const end = range?.end != null ? Math.min(range.end + 1, bytes.length) : bytes.length;
  const slice = bytes.subarray(start, end);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(slice);
      controller.close();
    },
  });
}
