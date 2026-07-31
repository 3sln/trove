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
 * Split the first `n` bytes off a stream and hand back the rest, unread.
 *
 * The envelope header sits at offset 0, so a whole-object read already fetches it — asking
 * for `bytes=0-43` and then re-fetching from 44 was a round trip that bought nothing.
 */
async function peel(stream, n) {
  const reader = stream.getReader();
  const parts = [];
  let have = 0;
  while (have < n) {
    const { value, done } = await reader.read();
    if (done) throw new Error('object ended inside its own header');
    parts.push(value);
    have += value.length;
  }
  const buf = new Uint8Array(have);
  let at = 0;
  for (const p of parts) { buf.set(p, at); at += p.length; }
  const leftover = buf.subarray(n);
  return {
    head: buf.subarray(0, n),
    rest: new ReadableStream({
      start(c) { if (leftover.length) c.enqueue(leftover); },
      async pull(c) {
        const { value, done } = await reader.read();
        if (done) c.close();
        else c.enqueue(value);
      },
      cancel(reason) { return reader.cancel(reason); },
    }),
  };
}

/**
 * Fetch and decrypt one object directly from the store.
 *
 * A WHOLE-object read costs one request: the header is the first 44 bytes of the body, so
 * it is peeled off the same stream. A RANGED read still costs two, because the nonce prefix
 * lives only in the header and nothing can compute where to start without it — see ticket
 * 010, which persists those eight bytes so this becomes one request as well.
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
  const wantsRange = !!parseRange(rangeHeader, Number.MAX_SAFE_INTEGER);
  let header;
  let whole = null; // the body stream, when the same request already carried it
  if (wantsRange) {
    const headRes = await fetch(plan.url, { headers: { Range: `bytes=0-${HEADER_BYTES - 1}` } });
    if (!headRes.ok) return null;
    header = decodeHeader(new Uint8Array(await headRes.arrayBuffer()));
  } else {
    const res = await fetch(plan.url);
    if (!res.ok || !res.body) return null;
    const split = await peel(res.body, HEADER_BYTES);
    header = decodeHeader(split.head);
    whole = split.rest;
  }

  // Mid-rotation the collection has more than one live key and this object may still be on
  // the retired one. The header says which; ask again for that exact key. The body stream
  // is already open and stays valid — only the key was wrong.
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

  let cipher = whole;
  if (!cipher) {
    const body = await fetch(plan.url, {
      headers: { Range: `bytes=${Math.max(want.cipherStart, HEADER_BYTES)}-${want.cipherEnd}` },
    });
    if (!body.ok || !body.body) return null;
    cipher = body.body;
  }

  const plain = await decryptStream(fromHex(plan.encryption.key), header, cipher, want.firstChunk);
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

/**
 * Plans already fetched, by node id (and by fingerprint where a retired key was asked for).
 *
 * A plan is a presigned URL and a key, and BOTH outlive the request that fetched them —
 * which matters most for the caller that generates the most requests. A <video> re-asks on
 * every seek, so without this a scrub costs a round trip to the drive per seek for a URL
 * and a key it was already holding; the same reasoning the `media` signed-URL purpose gives
 * for its twelve-hour life. A gallery gets it too: the second tile onward is free.
 *
 * Capped, because a worker outlives any one page and an unbounded map in it is a leak that
 * nothing ever clears. Oldest out first — insertion order is what a Map iterates.
 */
const PLANS = new Map();
const PLAN_CACHE_MAX = 256;
/** Re-fetch at 80% of the remaining life, so a plan is never used at the edge of expiry. */
const REFRESH_AT = 0.8;

const planKey = (id, fingerprint) => (fingerprint ? `${id} ${fingerprint}` : id);

function cached(key) {
  const hit = PLANS.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.usableUntil) {
    PLANS.delete(key);
    return null;
  }
  return hit.plan;
}

function remember(key, plan) {
  if (!plan?.direct) return; // nothing worth holding; a refusal is cheap to re-ask
  // No expiry — an older server, or one that could not presign — means no idea when this
  // URL dies, and a URL that fails at an unpredictable moment is worse than asking again.
  // Held only for a life we were actually told about.
  const life = plan.expiresAt ? plan.expiresAt - Date.now() : 0;
  if (life <= 0) return;
  PLANS.set(key, { plan, usableUntil: Date.now() + life * REFRESH_AT });
  if (PLANS.size > PLAN_CACHE_MAX) PLANS.delete(PLANS.keys().next().value);
}

/** Forget everything — the app calls this when a rotation lands and old keys retire. */
export function forgetPlans() {
  PLANS.clear();
}

async function getPlan(id, fingerprint, apiFetch) {
  const key = planKey(id, fingerprint);
  const hit = cached(key);
  if (hit) return hit;
  const q = `id=${encodeURIComponent(id)}${fingerprint ? `&fingerprint=${fingerprint}` : ''}`;
  try {
    const res = await apiFetch(`/api/items/download/plan?${q}`);
    if (!res.ok) return null; // 401/403 on a token-auth deployment: proxy, as before
    const plan = await res.json();
    remember(key, plan);
    return plan;
  } catch {
    return null;
  }
}
