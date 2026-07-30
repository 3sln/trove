// The wrapper around an encrypted object's bytes.
//
// An encrypted item is not a blob of ciphertext — it is a readable header followed by
// independently-encrypted chunks. Both halves of that are load-bearing.
//
// READABLE HEADER. Whoever holds the object must be able to learn what key it wants
// without having the key: which collection key encrypted it (the fingerprint), how it was
// encrypted, and how big it really is. That is what lets a sideloaded object — one copied
// into the bucket from somewhere else, or left behind by a half-finished key rotation —
// be matched to a key instead of being an unreadable mystery. It is also why the
// collection carries a fingerprint AND every object carries one: the collection's says
// which key to ask the user for, the object's says whether this particular object is
// actually encrypted with it.
//
// CHUNKS. Range requests are load-bearing in this drive already: the service worker slices
// ranges out of pinned files, the text viewer reads the first 512KB of a large file rather
// than pulling gigabytes to show a screenful, and media seeking is a range request per
// seek. A single AES-GCM blob has exactly one authentication tag over the whole message,
// so reading one byte means fetching and decrypting all of them. Fixed-size chunks turn a
// plaintext range into a chunk range, and only those chunks are fetched and decrypted.
//
// The cost is honest and small: 16 bytes of tag per chunk, and a header. At the default
// chunk size that is under 0.02% overhead.

import { TroveError } from '../errors.js';

/** "TRV1" — enough to recognise the format, and to refuse bytes that are not it. */
const MAGIC = new Uint8Array([0x54, 0x52, 0x56, 0x31]);

export const VERSION = 1;
/** AES-256-GCM. Recorded per object so the format can gain another without ambiguity. */
export const ALG_AES_256_GCM = 1;

/** AES-GCM's authentication tag. */
export const TAG_BYTES = 16;
/** Random per object; the per-chunk nonce is this followed by the chunk index. */
const NONCE_PREFIX_BYTES = 8;
const NONCE_BYTES = 12;
/** Truncated: 128 bits is far past collision risk for "which key is this". */
export const FINGERPRINT_BYTES = 16;

export const HEADER_BYTES = 44;

/**
 * 1 MiB of plaintext per chunk.
 *
 * The trade is seek granularity against overhead and round trips. Too small and a large
 * file becomes thousands of tags and a range read becomes many requests; too large and
 * seeking to one second of audio drags megabytes. 1 MiB keeps overhead at 16 bytes per
 * MiB — about 0.0015% — while keeping a seek to roughly one chunk.
 */
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;

/**
 * How many bytes the ciphertext of a plaintext of this size occupies.
 *
 * Needed before a single byte is encrypted: the upload plan negotiates part boundaries and
 * a per-file size limit against the size that will actually be STORED, and a plan computed
 * against the plaintext size is wrong by a tag per chunk. On a multipart upload that is the
 * difference between a final part that exists and one that does not.
 */
export function cipherSize(plaintextSize, chunkSize = DEFAULT_CHUNK_SIZE) {
  assertChunkSize(chunkSize);
  if (!(plaintextSize >= 0)) throw TroveError.invalid('plaintextSize must be a non-negative number');
  // An empty file still gets a header, and still has one (empty) chunk — so that "is this
  // encrypted" has the same answer for an empty file as for any other.
  const chunks = plaintextSize === 0 ? 1 : Math.ceil(plaintextSize / chunkSize);
  return HEADER_BYTES + plaintextSize + chunks * TAG_BYTES;
}

/** The inverse, for reporting the real size of something already stored. */
export function plaintextSizeOf(cipherTotal, chunkSize = DEFAULT_CHUNK_SIZE) {
  assertChunkSize(chunkSize);
  const body = cipherTotal - HEADER_BYTES;
  if (body < TAG_BYTES) throw TroveError.invalid('Ciphertext is too short to be an envelope');
  const full = Math.floor(body / (chunkSize + TAG_BYTES));
  const rest = body - full * (chunkSize + TAG_BYTES);
  // A trailing partial chunk still carries a full tag.
  return full * chunkSize + Math.max(0, rest - TAG_BYTES);
}

function assertChunkSize(chunkSize) {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > 0xffffffff) {
    throw TroveError.invalid(`Invalid chunk size ${chunkSize}`);
  }
}

/**
 * @typedef {object} EnvelopeHeader
 * @property {number} version
 * @property {number} algorithm
 * @property {number} chunkSize     plaintext bytes per chunk
 * @property {number} plaintextSize the real size, which the ciphertext length does not give
 * @property {Uint8Array} noncePrefix
 * @property {Uint8Array} fingerprint which key this was encrypted with
 */

/** @param {EnvelopeHeader} h */
export function encodeHeader(h) {
  const out = new Uint8Array(HEADER_BYTES);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[4] = h.version ?? VERSION;
  out[5] = h.algorithm ?? ALG_AES_256_GCM;
  // 6..7 reserved: written as zero and required to BE zero on read, so a future flag
  // cannot be silently ignored by a reader that predates it.
  view.setUint32(8, h.chunkSize, true);
  // A double holds an exact integer to 2^53, which is 9 petabytes — past any file, and
  // past what the rest of this codebase handles as a JS number anyway.
  view.setBigUint64(12, BigInt(h.plaintextSize), true);
  out.set(h.noncePrefix, 20);
  out.set(h.fingerprint, 28);
  return out;
}

/** @returns {EnvelopeHeader} */
export function decodeHeader(bytes) {
  if (bytes.length < HEADER_BYTES) throw TroveError.invalid('Not an encrypted object: too short');
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw TroveError.invalid('Not an encrypted object');
  }
  const version = bytes[4];
  if (version !== VERSION) {
    // Named rather than "corrupt". A reader that meets a newer envelope should say the
    // drive is newer than it is, not that the file is broken.
    throw TroveError.invalid(`This object uses envelope version ${version}, and this client understands ${VERSION}`);
  }
  const algorithm = bytes[5];
  if (algorithm !== ALG_AES_256_GCM) throw TroveError.invalid(`Unknown encryption algorithm ${algorithm}`);
  if (bytes[6] !== 0 || bytes[7] !== 0) {
    throw TroveError.invalid('This object sets envelope flags this client does not understand');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkSize = view.getUint32(8, true);
  assertChunkSize(chunkSize);
  return {
    version,
    algorithm,
    chunkSize,
    plaintextSize: Number(view.getBigUint64(12, true)),
    noncePrefix: bytes.slice(20, 20 + NONCE_PREFIX_BYTES),
    fingerprint: bytes.slice(28, 28 + FINGERPRINT_BYTES),
  };
}

/** Does this look like one of ours? Cheap, and does not need the key. */
export function isEnvelope(bytes) {
  if (!bytes || bytes.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}

/**
 * The nonce for one chunk: the object's random prefix, then the chunk index.
 *
 * Uniqueness per (key, nonce) is the one thing AES-GCM cannot survive losing — a repeat
 * leaks the XOR of two plaintexts and, worse, the authentication key. The prefix is random
 * per object so two objects never collide, and the counter makes chunks within an object
 * distinct. This is why an object may never be re-encrypted in place under the same key
 * with a fresh prefix omitted: rotation writes a NEW object.
 */
function nonceFor(prefix, chunkIndex) {
  const nonce = new Uint8Array(NONCE_BYTES);
  nonce.set(prefix, 0);
  new DataView(nonce.buffer).setUint32(NONCE_PREFIX_BYTES, chunkIndex, true);
  return nonce;
}

/**
 * Which ciphertext bytes are needed to answer a plaintext range, and how much of the
 * decrypted result to discard at each end.
 *
 * This is the whole reason for chunking. A viewer asking for the first 512KB of a 4GB file
 * gets one chunk fetched instead of four gigabytes.
 *
 * @param {{start: number, end: number}} range inclusive plaintext byte range
 * @param {EnvelopeHeader} header
 */
export function cipherRangeFor(range, header) {
  const { chunkSize, plaintextSize } = header;
  const start = Math.max(0, range.start);
  const end = Math.min(range.end ?? plaintextSize - 1, plaintextSize - 1);
  if (start > end) throw TroveError.invalid('Empty or reversed range');
  const firstChunk = Math.floor(start / chunkSize);
  const lastChunk = Math.floor(end / chunkSize);
  const stride = chunkSize + TAG_BYTES;
  return {
    firstChunk,
    lastChunk,
    // Inclusive ciphertext byte range to fetch.
    cipherStart: HEADER_BYTES + firstChunk * stride,
    cipherEnd: Math.min(HEADER_BYTES + (lastChunk + 1) * stride, cipherSize(plaintextSize, chunkSize)) - 1,
    // Once those chunks are decrypted and joined, the caller wants this slice of them.
    trimStart: start - firstChunk * chunkSize,
    trimEnd: end - firstChunk * chunkSize + 1,
  };
}

async function importKey(rawKey) {
  if (!(rawKey instanceof Uint8Array) || rawKey.length !== 32) {
    throw TroveError.invalid('An AES-256 key must be 32 bytes');
  }
  return crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * Encrypt a whole object.
 *
 * @param {Uint8Array} rawKey 32-byte data key
 * @param {Uint8Array} plaintext
 * @param {{fingerprint: Uint8Array, chunkSize?: number}} opts
 * @returns {Promise<Uint8Array>} header + chunks
 */
export async function encrypt(rawKey, plaintext, { fingerprint, chunkSize = DEFAULT_CHUNK_SIZE } = {}) {
  assertChunkSize(chunkSize);
  if (!fingerprint || fingerprint.length !== FINGERPRINT_BYTES) {
    throw TroveError.invalid(`A fingerprint must be ${FINGERPRINT_BYTES} bytes`);
  }
  const key = await importKey(rawKey);
  const noncePrefix = crypto.getRandomValues(new Uint8Array(NONCE_PREFIX_BYTES));
  const header = encodeHeader({
    version: VERSION,
    algorithm: ALG_AES_256_GCM,
    chunkSize,
    plaintextSize: plaintext.length,
    noncePrefix,
    fingerprint,
  });

  const out = new Uint8Array(cipherSize(plaintext.length, chunkSize));
  out.set(header, 0);
  let at = HEADER_BYTES;
  const chunks = plaintext.length === 0 ? 1 : Math.ceil(plaintext.length / chunkSize);
  for (let i = 0; i < chunks; i++) {
    const slice = plaintext.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, plaintext.length));
    const sealed = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonceFor(noncePrefix, i) }, key, slice,
    ));
    out.set(sealed, at);
    at += sealed.length;
  }
  return out;
}

/**
 * Decrypt a whole object.
 *
 * A failure here is deliberately not distinguished into "wrong key" versus "tampered":
 * AES-GCM cannot tell them apart, and a message that guessed would be guessing.
 */
export async function decrypt(rawKey, envelope) {
  const header = decodeHeader(envelope);
  const key = await importKey(rawKey);
  return decryptChunks(key, envelope.subarray(HEADER_BYTES), header, 0);
}

/**
 * Decrypt a run of chunks that starts at `firstChunk` — the partner of `cipherRangeFor`,
 * for the case where only part of the object was fetched.
 */
export async function decryptRange(rawKey, cipherPart, header, firstChunk) {
  const key = await importKey(rawKey);
  return decryptChunks(key, cipherPart, header, firstChunk);
}

async function decryptChunks(key, body, header, firstChunk) {
  const { chunkSize, noncePrefix } = header;
  const stride = chunkSize + TAG_BYTES;
  const pieces = [];
  let total = 0;
  for (let at = 0, i = firstChunk; at < body.length; at += stride, i++) {
    const sealed = body.subarray(at, Math.min(at + stride, body.length));
    if (sealed.length <= TAG_BYTES && sealed.length !== TAG_BYTES) {
      throw TroveError.invalid('Truncated encrypted object');
    }
    let opened;
    try {
      opened = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonceFor(noncePrefix, i) }, key, sealed,
      ));
    } catch {
      throw TroveError.invalid('Could not decrypt: wrong key, or the data has been altered');
    }
    pieces.push(opened);
    total += opened.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of pieces) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * Decrypt a ciphertext stream chunk by chunk, without holding the object in memory.
 *
 * The buffering version is fine for a text preview and wrong for a two-hour video: a
 * server that decrypted whole objects would hold one per concurrent viewer, and on a
 * Worker that is the memory limit rather than a slowdown. This reassembles exactly one
 * chunk at a time and emits its plaintext as soon as the tag verifies.
 *
 * Emitting per chunk does mean unverified bytes are never emitted, but earlier chunks are
 * released before later ones are checked — which is inherent to streaming anything
 * authenticated, and is why the chunk is the unit of trust rather than the file.
 *
 * @param {Uint8Array} rawKey
 * @param {EnvelopeHeader} header
 * @param {ReadableStream<Uint8Array>} cipherStream body only, no header
 * @param {number} [firstChunk] index of the first chunk in the stream
 */
export async function decryptStream(rawKey, header, cipherStream, firstChunk = 0) {
  const key = await importKey(rawKey);
  const stride = header.chunkSize + TAG_BYTES;
  const reader = cipherStream.getReader();
  let held = new Uint8Array(0);
  let index = firstChunk;

  const take = (n) => {
    const out = held.subarray(0, n);
    held = held.subarray(n);
    return out;
  };
  const open = async (sealed) => {
    try {
      return new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonceFor(header.noncePrefix, index++) }, key, sealed,
      ));
    } catch {
      throw TroveError.invalid('Could not decrypt: wrong key, or the data has been altered');
    }
  };

  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        if (held.length >= stride) {
          controller.enqueue(await open(take(stride)));
          return;
        }
        const { value, done } = await reader.read();
        if (done) {
          // Whatever is left is the final, partial chunk — still a whole tag, but fewer
          // than a chunk of plaintext.
          if (held.length) {
            if (held.length < TAG_BYTES) throw TroveError.invalid('Truncated encrypted object');
            controller.enqueue(await open(take(held.length)));
          }
          controller.close();
          return;
        }
        const grown = new Uint8Array(held.length + value.length);
        grown.set(held, 0);
        grown.set(value, held.length);
        held = grown;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * Seal a plaintext stream into an envelope stream, a chunk at a time.
 *
 * The counterpart to `decryptStream`, and needed for the same reason: `encrypt` allocates
 * the whole ciphertext, so re-encrypting a large object meant holding the file twice over —
 * once decrypted and once sealed. On a Cloudflare isolate that is the memory limit rather
 * than a slowdown, which capped key rotation at small files.
 *
 * The size has to be known up front because it goes in the header, which is written before
 * any chunk. That is not a limitation in practice: every caller is re-sealing something
 * whose size is already recorded.
 *
 * @param {Uint8Array} rawKey
 * @param {ReadableStream<Uint8Array>} plaintext
 * @param {{fingerprint: Uint8Array, plaintextSize: number, chunkSize?: number}} opts
 */
export async function encryptStream(rawKey, plaintext, { fingerprint, plaintextSize, chunkSize = DEFAULT_CHUNK_SIZE } = {}) {
  assertChunkSize(chunkSize);
  if (!fingerprint || fingerprint.length !== FINGERPRINT_BYTES) {
    throw TroveError.invalid(`A fingerprint must be ${FINGERPRINT_BYTES} bytes`);
  }
  const key = await importKey(rawKey);
  const noncePrefix = crypto.getRandomValues(new Uint8Array(NONCE_PREFIX_BYTES));
  const header = encodeHeader({
    version: VERSION, algorithm: ALG_AES_256_GCM, chunkSize, plaintextSize, noncePrefix, fingerprint,
  });

  const reader = plaintext.getReader();
  let held = new Uint8Array(0);
  let index = 0;
  let wroteHeader = false;
  let seen = 0;

  const seal = async (piece) => new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonceFor(noncePrefix, index++) }, key, piece,
  ));

  return new ReadableStream({
    async pull(controller) {
      if (!wroteHeader) {
        wroteHeader = true;
        controller.enqueue(header);
        return;
      }
      for (;;) {
        if (held.length >= chunkSize) {
          const piece = held.subarray(0, chunkSize);
          held = held.subarray(chunkSize);
          seen += piece.length;
          controller.enqueue(await seal(piece));
          return;
        }
        const { value, done } = await reader.read();
        if (done) {
          // The trailing partial chunk — and, for an empty file, the one empty chunk that
          // makes "is this encrypted" answerable the same way at any size.
          if (held.length || seen === 0) {
            seen += held.length;
            controller.enqueue(await seal(held));
            held = new Uint8Array(0);
          }
          if (seen !== plaintextSize) {
            // Refused rather than written: an envelope whose header disagrees with its body
            // decrypts to the wrong length forever, and the header cannot be fixed later
            // without re-encrypting.
            throw TroveError.invalid(
              `Expected ${plaintextSize} bytes to encrypt and received ${seen}`,
            );
          }
          controller.close();
          return;
        }
        const grown = new Uint8Array(held.length + value.length);
        grown.set(held, 0);
        grown.set(value, held.length);
        held = grown;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
