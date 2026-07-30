// The envelope and the key model.
//
// Two properties here are the whole point and everything else is plumbing:
//
//   A plaintext range costs one chunk range, not the whole file — otherwise seeking in an
//   encrypted video means downloading the video.
//
//   Neither the key nor the fingerprint is a cheap function of the passphrase. The
//   adversary is the storage host and they are holding the ciphertext, so anything they
//   can check quickly, they can guess.

import { test, expect } from 'bun:test';
import {
  encrypt, decrypt, decryptRange, encodeHeader, decodeHeader, isEnvelope,
  cipherSize, plaintextSizeOf, cipherRangeFor,
  HEADER_BYTES, TAG_BYTES, DEFAULT_CHUNK_SIZE, FINGERPRINT_BYTES, VERSION,
} from '../src/encryption/envelope.js';
import {
  deriveDataKey, fingerprint, fingerprintHex, describeKey, matchesCollection,
  newSalt, DEFAULT_KDF, KEY_BYTES,
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

test('the data key is not a hash of the passphrase', async () => {
  // If it were, the storage host — who holds the ciphertext — could guess offline at
  // billions of attempts a second, and a passphrase a human chose would not survive it.
  const salt = newSalt();
  const key = await deriveDataKey('correct horse battery staple', salt, { name: 'PBKDF2-SHA256', iterations: 1000 });
  expect(key.length).toBe(KEY_BYTES);
  const plainHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('correct horse battery staple')));
  expect(Buffer.from(key).equals(Buffer.from(plainHash))).toBe(false);
});

test('the same passphrase under a different salt is a different key', async () => {
  // So a guess made against one collection is worth nothing against another.
  const kdf = { name: 'PBKDF2-SHA256', iterations: 1000 };
  const a = await deriveDataKey('hunter2', newSalt(), kdf);
  const b = await deriveDataKey('hunter2', newSalt(), kdf);
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
});

test('the fingerprint is not a cheap oracle for the passphrase', async () => {
  // Published on the collection and on every object, so if it were H(H(passphrase)) an
  // attacker could test a guess with one hash instead of a real decryption attempt.
  const salt = newSalt();
  const kdf = { name: 'PBKDF2-SHA256', iterations: 1000 };
  const key = await deriveDataKey('hunter2', salt, kdf);
  const fp = await fingerprint(key);
  const doubleHash = new Uint8Array(await crypto.subtle.digest('SHA-256',
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode('hunter2'))));
  expect(Buffer.from(fp).equals(Buffer.from(doubleHash.subarray(0, fp.length)))).toBe(false);
  // Deterministic, though — it has to identify the key across devices and objects.
  expect(fingerprintHex(await fingerprint(key))).toBe(fingerprintHex(fp));
});

test('a collection records enough to re-derive and nothing that reveals', async () => {
  const { dataKey, config } = await describeKey('hunter2', { kdf: { name: 'PBKDF2-SHA256', iterations: 1000 } });
  expect(dataKey.length).toBe(KEY_BYTES);
  expect(config.salt).toMatch(/^[0-9a-f]+$/);
  expect(config.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  // The passphrase is nowhere in what gets stored.
  expect(JSON.stringify(config)).not.toContain('hunter2');
  expect(config.kdf.iterations).toBe(1000);
});

test('a key can be checked against a collection before anything is downloaded', async () => {
  const { config } = await describeKey('hunter2', { kdf: { name: 'PBKDF2-SHA256', iterations: 1000 } });
  const right = await matchesCollection('hunter2', config);
  expect(right.ok).toBe(true);
  expect(right.dataKey.length).toBe(KEY_BYTES);
  const wrong = await matchesCollection('hunter3', config);
  expect(wrong.ok).toBe(false);
  // And a rejected key is not handed back, so nothing downstream can use it by accident.
  expect(wrong.dataKey).toBe(null);
});

test('an unimplemented KDF is named rather than silently substituted', async () => {
  // A collection written by a newer client must not be derived the old way and then fail
  // to decrypt with a message about the data being altered.
  await expect(deriveDataKey('x', newSalt(), { name: 'Argon2id', iterations: 3 }))
    .rejects.toThrow(/key derivation "Argon2id"/);
});

test('the default cost is the published guidance, not a placeholder', async () => {
  expect(DEFAULT_KDF.iterations).toBeGreaterThanOrEqual(600_000);
});

test('an end-to-end pass: passphrase in, object out, passphrase back in', async () => {
  const kdf = { name: 'PBKDF2-SHA256', iterations: 1000 };
  const { dataKey, config } = await describeKey('a good long passphrase', { kdf });
  const fp = await fingerprint(dataKey);
  const plain = new TextEncoder().encode('the quarterly numbers, which are nobody else’s business');

  const sealed = await encrypt(dataKey, plain, { fingerprint: fp, chunkSize: 32 });
  // What the collection says it wants and what the object says it wants agree.
  expect(fingerprintHex(decodeHeader(sealed).fingerprint)).toBe(config.fingerprint);

  const { dataKey: reopened } = await matchesCollection('a good long passphrase', config);
  expect(await decrypt(reopened, sealed)).toEqual(plain);
});
