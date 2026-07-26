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
    return { presignDownload: false, presignUpload: false, multipart: false, range: false, list: false };
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
