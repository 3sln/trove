// An encrypted item, end to end through the Vfs.
//
// The unit tests prove the envelope and the plan separately. This proves the thing that
// actually matters: bytes go in, the BUCKET holds ciphertext, and reads come back as the
// file — including ranged reads, which is what the viewer and every media seek do.

import { test, expect } from 'bun:test';
import { createVfs, CollectionService, MemoryKV, MemoryStorage, isEnvelope, decodeHeader, fingerprintHex } from '../src/index.js';

const BOSS = { id: 'boss', roles: [] };
const text = (s) => new TextEncoder().encode(s);

async function drive({ rules = { all: true } } = {}) {
  const kv = new MemoryKV();
  const storage = new MemoryStorage();
  const collections = new CollectionService({ kv, storageFactory: () => storage, admins: ['boss'] });
  const secret = await collections.create({
    name: 'Private', store: { driver: 'memory' }, encryption: { enabled: true, rules },
  }, BOSS);
  const open = await collections.create({ name: 'Open', store: { driver: 'memory' } }, BOSS);
  const vfs = await createVfs({ storage, collections });
  return { vfs, collections, storage, secret, open };
}

/** Put a file in, the way the upload routes do. */
async function put(d, collectionId, name, body, contentType = 'text/plain') {
  const plan = await d.vfs.createUpload({ collectionId, name, size: body.length, contentType });
  // Plaintext: the drive seals on the way to the store now.
  await d.vfs.uploads.uploadPart(plan.uploadId, 1, body);
  return d.vfs.completeUpload(plan.uploadId);
}

test('the bucket holds ciphertext and the drive returns the file', async () => {
  const d = await drive();
  const body = text('the quarterly numbers, which are nobody else’s business');
  const done = await put(d, d.secret.id, 'q.txt', body);

  // What the storage actually holds is an envelope, not the text.
  const raw = await d.storage.get(done.storageKey);
  const stored = new Uint8Array(await new Response(raw.stream).arrayBuffer());
  expect(isEnvelope(stored)).toBe(true);
  expect(new TextDecoder().decode(stored)).not.toContain('quarterly');
  // And it names the key that opens it.
  expect(fingerprintHex(decodeHeader(stored).fingerprint)).toBe(d.secret.encryption.fingerprint);

  // The item records the size of the FILE, not of the envelope.
  expect(done.size).toBe(body.length);
  expect(done.encryption.fingerprint).toBe(d.secret.encryption.fingerprint);
});

test('an unencrypted collection stores exactly what it was given', async () => {
  const d = await drive();
  const body = text('nothing secret here');
  const done = await put(d, d.open.id, 'plain.txt', body);
  const raw = await d.storage.get(done.storageKey);
  const stored = new Uint8Array(await new Response(raw.stream).arrayBuffer());
  expect(isEnvelope(stored)).toBe(false);
  expect(new TextDecoder().decode(stored)).toBe('nothing secret here');
  expect(done.encryption).toBe(null);
});

test('rules decide per item within one collection', async () => {
  const d = await drive({ rules: { extensions: ['secret'] } });
  const a = await put(d, d.secret.id, 'a.secret', text('hidden'), 'application/octet-stream');
  const b = await put(d, d.secret.id, 'b.txt', text('visible'), 'text/plain');
  expect(a.encryption).toBeTruthy();
  expect(b.encryption).toBe(null);
});

test('a download is proxied rather than redirected, because a bare URL cannot decrypt', async () => {
  // An <img src>, a <video src> and a signed URL handed to an external service all get
  // bytes and have nowhere to run our code. Proxying is the answer that is always correct.
  const d = await drive();
  const done = await put(d, d.secret.id, 'q.txt', text('hello'));
  const dl = await d.vfs.getDownload(done.id);
  expect(dl.mode).toBe('proxy');
  // A client that holds the key can still ask for the direct path.
  const direct = await d.vfs.getDownload(done.id, { ciphertext: true });
  expect(direct.mode).toBe('proxy'); // MemoryStorage cannot presign; the gate is what matters
});

test('reading it back gives the file, not the envelope', async () => {
  const d = await drive();
  const body = text('the quarterly numbers, which are nobody else’s business');
  const done = await put(d, d.secret.id, 'q.txt', body);
  const read = await d.vfs.readStream(done.id);
  const out = new Uint8Array(await new Response(read.stream).arrayBuffer());
  expect(out).toEqual(body);
  expect(read.size).toBe(body.length);
});

test('a ranged read returns exactly the bytes asked for', async () => {
  // What the text viewer does for a large file, and what every media seek does. If this
  // were wrong the symptom would be a viewer showing the middle of a file from its start.
  const d = await drive();
  const body = text('0123456789abcdefghijklmnopqrstuvwxyz');
  const done = await put(d, d.secret.id, 'r.txt', body, 'application/octet-stream');
  const read = await d.vfs.readStream(done.id, { range: { start: 10, end: 19 } });
  const out = new Uint8Array(await new Response(read.stream).arrayBuffer());
  expect(new TextDecoder().decode(out)).toBe('abcdefghij');
});

test('a range that runs past the end is clamped to the file', async () => {
  const d = await drive();
  const body = text('short');
  const done = await put(d, d.secret.id, 's.txt', body);
  const read = await d.vfs.readStream(done.id, { range: { start: 2, end: 9999 } });
  const out = new Uint8Array(await new Response(read.stream).arrayBuffer());
  expect(new TextDecoder().decode(out)).toBe('ort');
});

test('an item whose key has been retired says so, rather than failing obscurely', async () => {
  // The one way this can genuinely break: a rotation that retired a key before every
  // object had moved onto the new one.
  const d = await drive();
  const done = await put(d, d.secret.id, 'q.txt', text('hello'));
  await d.collections.beginRotation(d.secret.id, BOSS);
  await d.collections.retireKey(d.secret.id, done.encryption.fingerprint, BOSS);
  await expect(d.vfs.readStream(done.id)).rejects.toThrow(/no longer holds/);
});

test('indexing reads plaintext, which is why search still works', async () => {
  // The whole reason the server holds the key. An indexer is handed the file, not the
  // envelope, so an encrypted collection is still searchable.
  const d = await drive();
  const body = text('slow-roasted tomato soup with garlic and basil');
  const done = await put(d, d.secret.id, 'recipe.txt', body);
  const seen = await d.vfs.readStream(done.id);
  const asText = await new Response(seen.stream).text();
  expect(asText).toContain('tomato soup');
});

test('the server-side write path seals too, and records the file size', async () => {
  // `writeFile` put bytes straight to the bucket and recorded the item with no `encryption`
  // at all, never asking whether the collection encrypts — a readable file in a collection
  // set up to be encrypted, stamped as unencrypted so the read path served it back happily.
  // Once the drive started sealing uploads this was the only way left to get plaintext in.
  const d = await drive();
  const node = await d.vfs.writeFile('server-side.txt', 'the quick brown fox', {
    collectionId: d.secret.id, contentType: 'text/plain',
  });

  expect(node.encryption?.fingerprint).toBe(d.secret.encryption.fingerprint);
  // The size a person sees is the FILE's, not the envelope's.
  expect(node.size).toBe('the quick brown fox'.length);
  // Reads back as the file…
  expect(await new Response((await d.vfs.readStream(node.id)).stream).text()).toBe('the quick brown fox');
  // …and what the bucket holds is an envelope, with the text nowhere in it.
  const raw = new Uint8Array(await new Response((await d.storage.get(node.storageKey)).stream).arrayBuffer());
  expect(isEnvelope(raw)).toBe(true);
  expect(new TextDecoder().decode(raw)).not.toContain('quick brown');
});

test('a collection that encrypts only some things still writes the rest in the clear', async () => {
  // `shouldEncrypt` takes the name and content type, so this path has to ask the same
  // question an upload asks or the two disagree about the same file.
  const d = await drive({ rules: { extensions: ['.secret'] } });
  const plain = await d.vfs.writeFile('notes.txt', 'hello', { collectionId: d.secret.id, contentType: 'text/plain' });
  expect(plain.encryption ?? null).toBe(null);

  const sealed = await d.vfs.writeFile('x.secret', 'hidden', { collectionId: d.secret.id, contentType: 'text/plain' });
  expect(sealed.encryption?.fingerprint).toBe(d.secret.encryption.fingerprint);
});
