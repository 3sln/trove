// Fetching ciphertext from the store and decrypting it here.
//
// The half of the encryption design that was never built. Uploads have always sealed in
// the browser and PUT straight to the bucket — the key travels, the bytes do not — but
// reads had no client-side decrypt, so `getDownload` never got asked for ciphertext and
// every read of an encrypted collection proxied through the drive.
//
// Sealed with the REAL encryptor and read back through the real range maths, because the
// failure mode this has to exclude is a nonce computed against one chunk layout and a
// chunk index against another: that surfaces as "the data has been altered" on data
// nobody altered.

import { test, expect } from 'bun:test';
import { encrypt, DEFAULT_CHUNK_SIZE } from '@3sln/trove/core/encryption/envelope.js';
import { fromHex, toHex } from '@3sln/trove/core/encryption/keys.js';
import { directRead, forgetPlans, parseRange, trimStream } from '../src/platform/directRead.js';

const KEY = new Uint8Array(32).fill(7);
const FP = new Uint8Array(16).fill(3);
const CHUNK = 64 * 1024;

/** Deterministic, non-uniform bytes — a truncation or mis-order cannot pass by luck. */
function body(n) {
  const b = new Uint8Array(n);
  let seed = 99;
  for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; b[i] = seed & 0xff; }
  return b;
}

/**
 * Stand in for the store and the plan endpoint.
 *
 * `fetch` is patched rather than injected because that is what the worker actually calls:
 * a bare URL to the bucket, honouring Range.
 */
function harness(sealed, plan) {
  forgetPlans(); // a module-level cache would otherwise leak between tests
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    const m = /^bytes=(\d+)-(\d+)$/.exec(init?.headers?.Range || '');
    const slice = m ? sealed.subarray(Number(m[1]), Number(m[2]) + 1) : sealed;
    return new Response(slice, { status: m ? 206 : 200 });
  };
  const apiFetch = async (path) => {
    calls.push(path);
    const fp = new URL(path, 'http://x').searchParams.get('fingerprint');
    const p = typeof plan === 'function' ? plan(fp) : plan;
    return p ? new Response(JSON.stringify(p)) : new Response('no', { status: 403 });
  };
  return { apiFetch, calls };
}

const PLAN = {
  direct: true,
  url: 'https://bucket.example/obj?signed=1',
  contentType: 'application/octet-stream',
  encryption: { algorithm: 'AES-256-GCM', chunkSize: CHUNK, fingerprint: toHex(FP), key: toHex(KEY) },
};

test('a whole encrypted object round-trips through the direct path', async () => {
  const plain = body(200 * 1024); // spans four chunks
  const sealed = await encrypt(KEY, plain, { fingerprint: FP, chunkSize: CHUNK });
  const { apiFetch, calls } = harness(sealed, PLAN);

  const res = await directRead('itm_1', null, apiFetch);
  expect(res.status).toBe(200);
  expect(res.headers.get('x-trove-direct')).toBe('1');
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(plain);

  // ONE request to the store: the header is the first 44 bytes of the body, so fetching it
  // separately and then re-fetching from 44 bought nothing.
  expect(calls.filter((c) => c.startsWith('https://')).length).toBe(1);
});

test('a ranged read fetches chunks, not the film', async () => {
  // The point of the range maths: seeking into a video must not pull the whole object.
  const plain = body(400 * 1024);
  const sealed = await encrypt(KEY, plain, { fingerprint: FP, chunkSize: CHUNK });
  const { apiFetch, calls } = harness(sealed, PLAN);

  const res = await directRead('itm_1', 'bytes=100000-100999', apiFetch);
  expect(res.status).toBe(206);
  expect(res.headers.get('content-range')).toBe(`bytes 100000-100999/${plain.length}`);
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(plain.subarray(100000, 101000));

  // The body request asked for a bounded slice of the envelope, not all of it.
  const bodyReq = calls.filter((c) => c.startsWith('https://')).length;
  expect(bodyReq).toBe(2); // header, then one bounded chunk range
});

test('a suffix range is served from the end', async () => {
  const plain = body(100 * 1024);
  const sealed = await encrypt(KEY, plain, { fingerprint: FP, chunkSize: CHUNK });
  const { apiFetch } = harness(sealed, PLAN);
  const res = await directRead('itm_1', 'bytes=-500', apiFetch);
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(plain.subarray(plain.length - 500));
});

test('mid-rotation, the header decides which key is asked for', async () => {
  // The collection has moved on but this object has not. The item record is a copy and can
  // be stale; the envelope is the authority. Asking with the current key would fail the
  // GCM tag and look like tampering.
  const oldKey = new Uint8Array(32).fill(11);
  const oldFp = new Uint8Array(16).fill(12);
  const plain = body(70 * 1024);
  const sealed = await encrypt(oldKey, plain, { fingerprint: oldFp, chunkSize: CHUNK });

  const asked = [];
  const { apiFetch } = harness(sealed, (fp) => {
    asked.push(fp);
    // Current key first, then the retired one once the header is read.
    return fp === toHex(oldFp)
      ? { ...PLAN, encryption: { ...PLAN.encryption, fingerprint: toHex(oldFp), key: toHex(oldKey) } }
      : PLAN;
  });

  const res = await directRead('itm_1', null, apiFetch);
  expect(asked).toEqual([null, toHex(oldFp)]);
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(plain);
});

test('anything that does not work falls back to the proxy', async () => {
  const sealed = await encrypt(KEY, body(1024), { fingerprint: FP, chunkSize: CHUNK });
  // No plan (a token-auth deployment the worker has no credentials for)
  expect(await directRead('itm_1', null, harness(sealed, null).apiFetch)).toBe(null);
  // A store that cannot presign
  expect(await directRead('itm_1', null, harness(sealed, { direct: false }).apiFetch)).toBe(null);
  // Nothing to decrypt — the server's own redirect already covers it
  expect(await directRead('itm_1', null, harness(sealed, { ...PLAN, encryption: null }).apiFetch)).toBe(null);
});

test('parseRange handles the forms a media element actually sends', () => {
  expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
  expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
  expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
  expect(parseRange('bytes=0-99999', 1000)).toEqual({ start: 0, end: 999 }); // clamped
  expect(parseRange(null, 1000)).toBe(null);
  expect(parseRange('bytes=', 1000)).toBe(null);
});

test('trimStream drops whole-chunk padding around the wanted bytes', async () => {
  const src = new ReadableStream({
    start(c) { c.enqueue(new Uint8Array([0, 1, 2, 3, 4])); c.enqueue(new Uint8Array([5, 6, 7, 8, 9])); c.close(); },
  });
  const out = new Uint8Array(await new Response(trimStream(src, 3, 8)).arrayBuffer());
  expect(out).toEqual(new Uint8Array([3, 4, 5, 6, 7]));
});

test('a second read of the same object does not re-ask for the plan', async () => {
  // The caller that generates the most requests is a <video>: it re-asks on every seek, and
  // without this each seek cost a round trip to the drive for a URL and a key it was
  // already holding.
  const plain = body(300 * 1024);
  const sealed = await encrypt(KEY, plain, { fingerprint: FP, chunkSize: CHUNK });
  const { apiFetch, calls } = harness(sealed, { ...PLAN, expiresAt: Date.now() + 3600_000 });

  await (await directRead('itm_1', 'bytes=0-99', apiFetch)).arrayBuffer();
  await (await directRead('itm_1', 'bytes=200000-200099', apiFetch)).arrayBuffer();
  const third = await directRead('itm_1', 'bytes=100-199', apiFetch);
  expect(new Uint8Array(await third.arrayBuffer())).toEqual(plain.subarray(100, 200));

  // One plan for three reads; the store is still asked each time, which is the point.
  expect(calls.filter((c) => c.startsWith('/api/'))).toHaveLength(1);
  expect(calls.filter((c) => c.startsWith('https://')).length).toBe(6); // header+body per read
});

test('an expired plan is fetched again rather than used', async () => {
  const sealed = await encrypt(KEY, body(1024), { fingerprint: FP, chunkSize: CHUNK });
  const { apiFetch, calls } = harness(sealed, { ...PLAN, expiresAt: Date.now() - 1 });
  await (await directRead('itm_1', null, apiFetch)).arrayBuffer();
  await (await directRead('itm_1', null, apiFetch)).arrayBuffer();
  expect(calls.filter((c) => c.startsWith('/api/'))).toHaveLength(2);
});

test('a plan with no expiry is never held', async () => {
  // `direct:false` and older servers that do not send `expiresAt`: re-ask rather than hold
  // a URL with no idea when it dies.
  const sealed = await encrypt(KEY, body(1024), { fingerprint: FP, chunkSize: CHUNK });
  const { apiFetch, calls } = harness(sealed, PLAN); // PLAN has no expiresAt
  await (await directRead('itm_1', null, apiFetch)).arrayBuffer();
  await (await directRead('itm_1', null, apiFetch)).arrayBuffer();
  expect(calls.filter((c) => c.startsWith('/api/'))).toHaveLength(2);
});
