// The envelope and the key model.
//
// Two properties here are the whole point and everything else is plumbing:
//
//   A plaintext range costs one chunk range, not the whole file — otherwise seeking in an
//   encrypted video means downloading the video.
//
//   An object names the key that sealed it, readably and without that key — which is what
//   lets a sideloaded object be identified, and what lets two keys be live at once while a
//   rotation works through a collection.

import { test, expect } from 'bun:test';
import {
  encrypt, encryptStream, decrypt, decryptRange, decryptStream, encodeHeader, decodeHeader, isEnvelope,
  cipherSize, plaintextSizeOf, cipherRangeFor,
  HEADER_BYTES, TAG_BYTES, DEFAULT_CHUNK_SIZE, FINGERPRINT_BYTES, VERSION,
} from '../src/encryption/envelope.js';
import {
  generateDataKey, newCollectionKey, fingerprint, fingerprintHex, KEY_BYTES,
} from '../src/encryption/keys.js';

const KEY = new Uint8Array(32).fill(7);
const FP = new Uint8Array(FINGERPRINT_BYTES).fill(9);
const bytes = (n, seed = 0) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251);

// --- round trip ---------------------------------------------------------------

test('an object round-trips, including across chunk boundaries', async () => {
  const chunkSize = 64;
  for (const size of [0, 1, 63, 64, 65, 200, 256]) {
    const plain = bytes(size, size);
    const sealed = await encrypt(KEY, plain, { fingerprint: FP, chunkSize });
    expect(sealed.length).toBe(cipherSize(size, chunkSize));
    expect(await decrypt(KEY, sealed)).toEqual(plain);
  }
});

test('the wrong key is refused rather than producing rubbish', async () => {
  const sealed = await encrypt(KEY, bytes(100), { fingerprint: FP, chunkSize: 64 });
  const wrong = new Uint8Array(32).fill(8);
  await expect(decrypt(wrong, sealed)).rejects.toThrow(/wrong key, or the data has been altered/);
});

test('tampering is caught, wherever it lands', async () => {
  const sealed = await encrypt(KEY, bytes(200), { fingerprint: FP, chunkSize: 64 });
  // A byte of ciphertext in the second chunk — the tag covers it.
  const hit = new Uint8Array(sealed);
  hit[HEADER_BYTES + 64 + TAG_BYTES + 3] ^= 0xff;
  await expect(decrypt(KEY, hit)).rejects.toThrow(/altered/);
});

test('every chunk gets its own nonce', async () => {
  // Identical plaintext chunks must not produce identical ciphertext, or the storage host
  // learns which parts of a file repeat. This is what the chunk counter in the nonce buys.
  const chunkSize = 32;
  const plain = new Uint8Array(96); // three identical all-zero chunks
  const sealed = await encrypt(KEY, plain, { fingerprint: FP, chunkSize });
  const body = sealed.subarray(HEADER_BYTES);
  const stride = chunkSize + TAG_BYTES;
  const c0 = body.subarray(0, stride);
  const c1 = body.subarray(stride, stride * 2);
  expect(Buffer.from(c0).equals(Buffer.from(c1))).toBe(false);
});

test('two encryptions of the same bytes differ', async () => {
  // The nonce prefix is random per object, so uploading the same file twice does not
  // announce that they are the same file.
  const plain = bytes(50);
  const a = await encrypt(KEY, plain, { fingerprint: FP, chunkSize: 64 });
  const b = await encrypt(KEY, plain, { fingerprint: FP, chunkSize: 64 });
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
});

// --- the header, which must be readable without the key ------------------------

test('the header says which key it wants, without the key', async () => {
  const sealed = await encrypt(KEY, bytes(100), { fingerprint: FP, chunkSize: 64 });
  const h = decodeHeader(sealed);
  expect(h.version).toBe(VERSION);
  expect(h.chunkSize).toBe(64);
  // The real size, which the ciphertext length alone cannot tell you.
  expect(h.plaintextSize).toBe(100);
  expect([...h.fingerprint]).toEqual([...FP]);
});

test('a sideloaded object can be matched to a key by anyone holding it', async () => {
  // The reason objects are tagged as well as collections: an object copied into the bucket
  // from elsewhere still says which key opens it.
  const sealed = await encrypt(KEY, bytes(10), { fingerprint: FP, chunkSize: 64 });
  expect(isEnvelope(sealed)).toBe(true);
  expect(fingerprintHex(decodeHeader(sealed).fingerprint)).toBe(fingerprintHex(FP));
});

test('plaintext is not mistaken for an envelope', async () => {
  expect(isEnvelope(new TextEncoder().encode('hello, this is a plain text file'))).toBe(false);
  expect(isEnvelope(new Uint8Array(0))).toBe(false);
  expect(() => decodeHeader(new TextEncoder().encode('not an envelope at all!!'))).toThrow(/Not an encrypted object/);
});

test('a newer envelope is reported as newer, not as corrupt', async () => {
  const h = encodeHeader({ version: 99, algorithm: 1, chunkSize: 64, plaintextSize: 0, noncePrefix: new Uint8Array(8), fingerprint: FP });
  expect(() => decodeHeader(h)).toThrow(/envelope version 99/);
});

test('unknown flags are refused rather than ignored', async () => {
  // A reader that predates a flag must not quietly do the wrong thing with it.
  const h = encodeHeader({ version: VERSION, algorithm: 1, chunkSize: 64, plaintextSize: 0, noncePrefix: new Uint8Array(8), fingerprint: FP });
  h[6] = 1;
  expect(() => decodeHeader(h)).toThrow(/flags this client does not understand/);
});

// --- size accounting -----------------------------------------------------------

test('stored size is known before anything is encrypted', async () => {
  // The upload plan negotiates part boundaries and per-file limits against what will
  // actually be stored. Computed from the plaintext size, a multipart plan is short by a
  // tag per chunk — which is a final part that does not exist.
  expect(cipherSize(0)).toBe(HEADER_BYTES + TAG_BYTES);
  expect(cipherSize(DEFAULT_CHUNK_SIZE)).toBe(HEADER_BYTES + DEFAULT_CHUNK_SIZE + TAG_BYTES);
  expect(cipherSize(DEFAULT_CHUNK_SIZE + 1)).toBe(HEADER_BYTES + DEFAULT_CHUNK_SIZE + 1 + 2 * TAG_BYTES);
  // And the overhead stays negligible at the default chunk size.
  const big = 1024 * 1024 * 1024;
  expect((cipherSize(big) - big) / big).toBeLessThan(0.0001);
});

test('and the real size can be recovered from the stored size', async () => {
  for (const size of [0, 1, 1000, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_SIZE * 3 + 17]) {
    expect(plaintextSizeOf(cipherSize(size), DEFAULT_CHUNK_SIZE)).toBe(size);
  }
});

// --- ranges, which is what chunking is for -------------------------------------

test('a range costs the chunks it touches, not the file', async () => {
  const chunkSize = DEFAULT_CHUNK_SIZE;
  const fourGB = 4 * 1024 * 1024 * 1024;
  const header = { chunkSize, plaintextSize: fourGB };
  // The text viewer's first 512KB of a 4GB file.
  const r = cipherRangeFor({ start: 0, end: 512 * 1024 - 1 }, header);
  expect(r.firstChunk).toBe(0);
  expect(r.lastChunk).toBe(0);
  expect(r.cipherEnd - r.cipherStart + 1).toBe(chunkSize + TAG_BYTES);
});

test('a range in the middle of a file decrypts to exactly the bytes asked for', async () => {
  const chunkSize = 64;
  const plain = bytes(500);
  const sealed = await encrypt(KEY, plain, { fingerprint: FP, chunkSize });
  const header = decodeHeader(sealed);

  const start = 100;
  const end = 260;
  const r = cipherRangeFor({ start, end }, header);
  const part = sealed.subarray(r.cipherStart, r.cipherEnd + 1);
  const opened = await decryptRange(KEY, part, header, r.firstChunk);
  expect(opened.subarray(r.trimStart, r.trimEnd)).toEqual(plain.subarray(start, end + 1));
});

test('a range running to the end of the file is clamped, not overrun', async () => {
  const chunkSize = 64;
  const plain = bytes(100);
  const sealed = await encrypt(KEY, plain, { fingerprint: FP, chunkSize });
  const header = decodeHeader(sealed);
  const r = cipherRangeFor({ start: 90, end: 1e9 }, header);
  const opened = await decryptRange(KEY, sealed.subarray(r.cipherStart, r.cipherEnd + 1), header, r.firstChunk);
  expect(opened.subarray(r.trimStart, r.trimEnd)).toEqual(plain.subarray(90));
});

// --- keys ----------------------------------------------------------------------

test('a collection key is generated, not derived from anything a user types', async () => {
  // A passphrase would buy nothing: the server knows the key either way, so there is no
  // protection to gain from the user holding one — and every cost would still apply.
  const a = generateDataKey();
  const b = generateDataKey();
  expect(a.length).toBe(KEY_BYTES);
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
});

test('the fingerprint names a key without being it', async () => {
  const key = generateDataKey();
  const fp = await fingerprint(key);
  expect(fp.length).toBe(16);
  // Deterministic, because it has to identify the same key across every object.
  expect(fingerprintHex(await fingerprint(key))).toBe(fingerprintHex(fp));
  // And not simply the key with a haircut.
  expect(fingerprintHex(fp)).not.toBe(fingerprintHex(key.subarray(0, 16)));
});

test('different keys get different names', async () => {
  const one = fingerprintHex(await fingerprint(generateDataKey()));
  const two = fingerprintHex(await fingerprint(generateDataKey()));
  expect(one).not.toBe(two);
});

test('a new collection key comes with the config that records it', async () => {
  const { dataKey, config } = await newCollectionKey();
  expect(dataKey.length).toBe(KEY_BYTES);
  expect(config.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  expect(config.fingerprint).toBe(fingerprintHex(await fingerprint(dataKey)));
  // The key is not in the config — they go to different places.
  expect(JSON.stringify(config)).not.toContain(fingerprintHex(dataKey));
});

test('a key that is not a key is refused', async () => {
  await expect(fingerprint(new Uint8Array(16))).rejects.toThrow(/must be 32 bytes/);
});

test('an end-to-end pass: key in, object out, key back in', async () => {
  const { dataKey, config } = await newCollectionKey();
  const fp = await fingerprint(dataKey);
  const plain = new TextEncoder().encode('the quarterly numbers, which are nobody else\u2019s business');

  const sealed = await encrypt(dataKey, plain, { fingerprint: fp, chunkSize: 32 });
  // What the collection says it wants and what the object says it wants agree.
  expect(fingerprintHex(decodeHeader(sealed).fingerprint)).toBe(config.fingerprint);
  expect(await decrypt(dataKey, sealed)).toEqual(plain);
});

test('an object sealed with a retired key is still identifiable, and still opens', async () => {
  // The rotation story: two keys are live at once, and an object is opened with whichever
  // one its envelope names.
  const oldKey = await newCollectionKey();
  const newKey = await newCollectionKey();
  const plain = new TextEncoder().encode('written before the rotation');
  const sealed = await encrypt(oldKey.dataKey, plain, { fingerprint: await fingerprint(oldKey.dataKey), chunkSize: 32 });

  // The collection now says its current key is the new one...
  expect(newKey.config.fingerprint).not.toBe(oldKey.config.fingerprint);
  // ...but the object still names the old one, so the right key is findable.
  expect(fingerprintHex(decodeHeader(sealed).fingerprint)).toBe(oldKey.config.fingerprint);
  expect(await decrypt(oldKey.dataKey, sealed)).toEqual(plain);
  await expect(decrypt(newKey.dataKey, sealed)).rejects.toThrow(/wrong key/);
});

test('a stream decrypts without holding the object in memory', async () => {
  // The buffering path is fine for a text preview and wrong for a two-hour video: a server
  // that decrypted whole objects would hold one per concurrent viewer, which on a Worker is
  // the memory limit rather than a slowdown.
  const chunkSize = 64;
  const plain = bytes(500);
  const sealed = await encrypt(KEY, plain, { fingerprint: FP, chunkSize });
  const header = decodeHeader(sealed);
  const body = sealed.subarray(HEADER_BYTES);

  // Delivered in awkward pieces that do not align to chunk boundaries, which is what a
  // network actually does.
  const source = new ReadableStream({
    start(c) {
      for (let at = 0; at < body.length; at += 37) c.enqueue(body.subarray(at, Math.min(at + 37, body.length)));
      c.close();
    },
  });
  const out = [];
  const reader = (await decryptStream(KEY, header, source)).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(value);
  }
  const joined = new Uint8Array(out.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of out) { joined.set(p, at); at += p.length; }
  expect(joined).toEqual(plain);
});

test('a tampered stream fails rather than emitting bad bytes for that chunk', async () => {
  const chunkSize = 64;
  const sealed = await encrypt(KEY, bytes(200), { fingerprint: FP, chunkSize });
  const header = decodeHeader(sealed);
  const body = new Uint8Array(sealed.subarray(HEADER_BYTES));
  body[5] ^= 0xff;
  const source = new ReadableStream({ start(c) { c.enqueue(body); c.close(); } });
  const reader = (await decryptStream(KEY, header, source)).getReader();
  await expect(reader.read()).rejects.toThrow(/altered/);
});

test('sealing a stream produces exactly what sealing a buffer would', async () => {
  // Same format, so an object written by the streaming path and one written by the
  // buffering path are indistinguishable to every reader.
  const chunkSize = 64;
  for (const size of [0, 1, 63, 64, 65, 300]) {
    const plain = bytes(size, size);
    const source = new ReadableStream({
      start(c) {
        for (let at = 0; at < plain.length; at += 23) c.enqueue(plain.subarray(at, Math.min(at + 23, plain.length)));
        c.close();
      },
    });
    const sealed = new Uint8Array(await new Response(
      await encryptStream(KEY, source, { fingerprint: FP, plaintextSize: size, chunkSize }),
    ).arrayBuffer());
    expect(sealed.length).toBe(cipherSize(size, chunkSize));
    expect(await decrypt(KEY, sealed)).toEqual(plain);
  }
});

test('a stream that delivers the wrong number of bytes is refused, not written', async () => {
  // The header states the size and is written first. An envelope whose header disagrees
  // with its body decrypts to the wrong length forever and cannot be corrected without
  // re-encrypting, so a short read has to fail loudly here.
  const source = new ReadableStream({ start(c) { c.enqueue(bytes(10)); c.close(); } });
  const out = await encryptStream(KEY, source, { fingerprint: FP, plaintextSize: 999, chunkSize: 64 });
  await expect(new Response(out).arrayBuffer()).rejects.toThrow(/Expected 999 bytes/);
});
