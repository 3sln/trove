// Reading an encrypted object straight from the store, decrypting on the way past.
//
// Encryption in Trove defends the STORAGE HOST — not the server, which holds the key in
// order to index, and not the client, which is handed the key on upload so it can seal
// before the bytes leave the browser. The upload half of that has always worked: the key
// travels, the bytes do not, and a presigned PUT goes straight to the bucket.
//
// The download half did not. `getDownload` refuses to redirect to ciphertext unless a
// caller says it can decrypt, nothing ever said so, and so every read of an encrypted
// collection proxied through the drive. Turning on encryption silently cost a deployment
// the direct downloads it had configured — worst for exactly the collections that wanted
// them most.
//
// This is the missing half, and it lives in the SERVICE WORKER for a reason: an `<img
// src>`, a `<video src>` and `cache.add()` fetch bare URLs and have nowhere to run
// decryption. Intercepting the download route means they do not have to — they ask for a
// URL as they always did, and get plaintext back, while the bytes came from the bucket.
//
// Everything here fails SOFT. Any error — no plan, no CORS on the bucket, a store that
// cannot presign — returns null, and the worker falls back to the proxy path that was the
// only path before. The worst case is what already happened.

import {
  HEADER_BYTES, cipherRangeFor, cipherSize, decodeHeader, decryptStream,
} from '@3sln/trove/core/encryption/envelope.js';
import { fromHex, toHex } from '@3sln/trove/core/encryption/keys.js';

/** `bytes=100-199` → `{start, end}`; null for anything else, including open-ended forms. */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  // A suffix range (`bytes=-500`) is the last N bytes.
  if (a === '') return { start: Math.max(0, size - Number(b)), end: size - 1 };
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  return end < start ? null : { start, end };
}

/**
 * Drop `start` bytes from the front and stop at `end`.
 *
 * A chunk is the unit of encryption, so the plaintext for a range arrives with whole
 * chunks around it. The server trims the same way (see vfs.readStream) — this is that,
 * client-side.
 */
export function trimStream(stream, start, end) {
  let seen = 0;
  const want = end - start;
  let sent = 0;
  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      if (sent >= want) return;
      const from = Math.max(0, start - seen);
      const to = Math.min(chunk.length, end - seen);
      if (to > from) {
        const slice = chunk.subarray(from, to);
        sent += slice.length;
        controller.enqueue(slice);
      }
      seen += chunk.length;
    },
  }));
}

/**
 * Fetch and decrypt one object directly from the store.
 *
 * @param {string} id node id
 * @param {string|null} rangeHeader the caller's Range header, if any
 * @param {(path: string) => Promise<Response>} apiFetch same-origin fetch, carrying whatever
 *   ambient credentials this context has
 * @returns {Promise<Response|null>} null whenever the direct path is not available
 */
export async function directRead(id, rangeHeader, apiFetch) {
  let plan = await getPlan(id, null, apiFetch);
  // `direct:false` is the honest answer from a store that cannot presign; no encryption
  // means the plain redirect the server already performs is fine and this adds nothing.
  if (!plan?.direct || !plan.encryption || !plan.url) return null;

  // The ENVELOPE is authoritative, not the item record — the record is a copy, and a copy
  // can be stale (an object restored from a backup, adopted by a scan, written by another
  // version). Deriving ranges from the record and decrypting with the object's real
  // geometry is how chunk indices get computed against one layout and nonces against
  // another, which surfaces as "the data has been altered" on data nobody altered.
  const headRes = await fetch(plan.url, { headers: { Range: `bytes=0-${HEADER_BYTES - 1}` } });
  if (!headRes.ok) return null;
  const header = decodeHeader(new Uint8Array(await headRes.arrayBuffer()));

  // Mid-rotation the collection has more than one live key and this object may still be on
  // the retired one. The header says which; ask again for that exact key.
  const sealedBy = toHex(header.fingerprint);
  if (sealedBy !== plan.encryption.fingerprint) {
    plan = await getPlan(id, sealedBy, apiFetch);
    if (!plan?.direct || !plan.encryption) return null;
  }

  const plaintextSize = header.plaintextSize ?? 0;
  const range = parseRange(rangeHeader, plaintextSize);
  const want = range
    ? cipherRangeFor({ start: range.start, end: range.end }, { ...header, plaintextSize })
    : {
      cipherStart: 0,
      cipherEnd: cipherSize(plaintextSize, header.chunkSize) - 1,
      firstChunk: 0,
      trimStart: 0,
      trimEnd: plaintextSize,
    };

  const body = await fetch(plan.url, {
    headers: { Range: `bytes=${Math.max(want.cipherStart, HEADER_BYTES)}-${want.cipherEnd}` },
  });
  if (!body.ok || !body.body) return null;

  const plain = await decryptStream(fromHex(plan.encryption.key), header, body.body, want.firstChunk);
  const size = want.trimEnd - want.trimStart;
  const headers = {
    'content-type': plan.contentType || 'application/octet-stream',
    'content-length': String(size),
    'accept-ranges': 'bytes',
    // So a person reading the network panel can tell these bytes never touched the drive.
    'x-trove-direct': '1',
  };
  if (range) {
    headers['content-range'] = `bytes ${range.start}-${range.start + size - 1}/${plaintextSize}`;
  }
  return new Response(trimStream(plain, want.trimStart, want.trimEnd), {
    status: range ? 206 : 200,
    headers,
  });
}

async function getPlan(id, fingerprint, apiFetch) {
  const q = `id=${encodeURIComponent(id)}${fingerprint ? `&fingerprint=${fingerprint}` : ''}`;
  try {
    const res = await apiFetch(`/api/items/download/plan?${q}`);
    if (!res.ok) return null; // 401/403 on a token-auth deployment: proxy, as before
    return await res.json();
  } catch {
    return null;
  }
}
