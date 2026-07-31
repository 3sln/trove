// Continuing one envelope across two calls.
//
// A rotation can be interrupted part-way through a large object; resuming means encrypting
// the rest as a continuation rather than starting again. Getting it wrong does not throw —
// it produces an object that decrypts to rubbish, or worse, one that reuses a nonce. So the
// property tested here is the only one that matters: the pieces, concatenated, are byte for
// byte what a single uninterrupted pass would have produced, and they decrypt.

import { test, expect } from 'bun:test';
import { encryptStream, decrypt, decodeHeader, HEADER_BYTES, TAG_BYTES } from '../src/encryption/envelope.js';
import { generateDataKey, fingerprint } from '../src/encryption/keys.js';

const CHUNK = 64 * 1024;

const streamOf = (bytes) => new ReadableStream({
  start(c) { c.enqueue(bytes); c.close(); },
});

async function collect(stream) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function body(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

test('a resumed envelope is identical to an uninterrupted one, and decrypts', async () => {
  const key = generateDataKey();
  const fp = await fingerprint(key);
  const plain = body(CHUNK * 5 + 1234);   // four whole chunks plus a short tail

  const whole = await collect(await encryptStream(key, streamOf(plain), {
    fingerprint: fp, plaintextSize: plain.length, chunkSize: CHUNK,
  }));

  // Stop after two whole chunks, then continue with the same prefix and the next index.
  const head = decodeHeader(whole);
  const cut = 2;
  // The first slice is PARTIAL — it stops early and something else finishes the object. It
  // is told the prefix so the continuation can match it; in the rotation the prefix is read
  // back off the header of what was already written.
  const firstAgain = await collect(await encryptStream(key, streamOf(plain.subarray(0, CHUNK * cut)), {
    fingerprint: fp, plaintextSize: plain.length, chunkSize: CHUNK,
    resume: { noncePrefix: head.noncePrefix, index: 0 }, partial: true,
  }));
  const rest = await collect(await encryptStream(key, streamOf(plain.subarray(CHUNK * cut)), {
    fingerprint: fp, plaintextSize: plain.length, chunkSize: CHUNK,
    resume: { noncePrefix: head.noncePrefix, index: cut },
  }));

  // `firstAgain` omits the header (it is a resume), so the reassembly is header + both.
  const joined = new Uint8Array(HEADER_BYTES + firstAgain.length + rest.length);
  joined.set(whole.subarray(0, HEADER_BYTES), 0);
  joined.set(firstAgain, HEADER_BYTES);
  joined.set(rest, HEADER_BYTES + firstAgain.length);

  expect(joined.length).toBe(whole.length);
  expect([...joined]).toEqual([...whole]);
  expect([...new Uint8Array(await decrypt(key, joined))]).toEqual([...plain]);
});

test('a resumed stream writes no second header', async () => {
  const key = generateDataKey();
  const fp = await fingerprint(key);
  const plain = body(CHUNK * 2);
  const prefix = decodeHeader(await collect(await encryptStream(key, streamOf(plain), {
    fingerprint: fp, plaintextSize: plain.length, chunkSize: CHUNK,
  }))).noncePrefix;

  const tail = await collect(await encryptStream(key, streamOf(plain.subarray(CHUNK)), {
    fingerprint: fp, plaintextSize: plain.length, chunkSize: CHUNK,
    resume: { noncePrefix: prefix, index: 1 },
  }));
  // One chunk in, one sealed chunk out — no 44 bytes of header on the front.
  expect(tail.length).toBe(CHUNK + TAG_BYTES);
});

test('resuming refuses a prefix or index it cannot trust', async () => {
  const key = generateDataKey();
  const fp = await fingerprint(key);
  const s = () => streamOf(body(16));
  const opts = { fingerprint: fp, plaintextSize: 16, chunkSize: CHUNK };
  // A wrong-length prefix would silently change the nonce derivation.
  await expect(encryptStream(key, s(), { ...opts, resume: { noncePrefix: new Uint8Array(4), index: 1 } }))
    .rejects.toThrow(/nonce prefix/);
  await expect(encryptStream(key, s(), { ...opts, resume: { noncePrefix: new Uint8Array(8) } }))
    .rejects.toThrow(/chunk index/);
});

test('a partial encrypt must stop on a chunk boundary', async () => {
  // Sealing a short chunk mid-object is how the envelope marks the END. Doing it in the
  // middle shifts every later chunk index and makes the recorded plaintext length a lie —
  // and neither shows up until someone tries to read the file.
  const key = generateDataKey();
  const fp = await fingerprint(key);
  const plain = body(CHUNK + 100);
  await expect(encryptStream(key, streamOf(plain), {
    fingerprint: fp, plaintextSize: plain.length, chunkSize: CHUNK,
    resume: { noncePrefix: new Uint8Array(8), index: 0 }, partial: true,
  }).then(collect)).rejects.toThrow(/chunk boundary/);
});
