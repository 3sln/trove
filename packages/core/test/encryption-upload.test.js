// What an upload plan says when the collection is encrypted.
//
// The client encrypts before the bytes leave the browser, so the plan has to carry the key
// AND has to be negotiated against the size of the envelope rather than the size of the
// file. Getting the second one wrong is the subtle failure: the plan looks right, the
// upload proceeds, and the final part is short by a header and a tag per chunk.

import { test, expect } from 'bun:test';
import { createVfs, CollectionService, MemoryKV, MemoryStorage, cipherSize, HEADER_BYTES, TAG_BYTES, DEFAULT_CHUNK_SIZE } from '../src/index.js';

const BOSS = { id: 'boss', roles: [] };

/**
 * A drive with one encrypted collection.
 *
 * Through `createVfs`, deliberately: the manager's sealing policy used to be injected here
 * as a hand-written copy of what Vfs injects, so this suite proved that COPY correct rather
 * than the shipped rule. `new UploadManager` belongs in exactly one place.
 */
async function drive({ rules = { all: true }, storage = new MemoryStorage(), maxBytes = null } = {}) {
  const collections = new CollectionService({
    kv: new MemoryKV(), storageFactory: () => storage, admins: ['boss'],
  });
  const c = await collections.create({
    name: 'Private', store: { driver: 'memory' },
    encryption: { enabled: true, rules },
  }, BOSS);
  const open = await collections.create({ name: 'Open', store: { driver: 'memory' } }, BOSS);
  const vfs = await createVfs({ storage, collections, maxUploadBytes: maxBytes });
  return { collections, vfs, uploads: vfs.uploads, encrypted: c, open };
}

test('the plan says encryption is happening and hands over nothing to do it with', async () => {
  // It used to carry the collection's data key so the browser could seal locally, which is
  // what made a presigned direct-to-bucket PUT possible. That trade is off: encrypted
  // collections pass through the drive, the drive seals, and the key never leaves it.
  const d = await drive();
  const plan = await d.uploads.create({ collectionId: d.encrypted.id, name: 'notes.txt', size: 100, contentType: 'text/plain' });
  expect(plan.encryption).toBeTruthy();
  expect(plan.encryption.algorithm).toBe('AES-256-GCM');
  expect(plan.encryption.sealedBy).toBe('server');
  expect(plan.encryption.key).toBeUndefined();
  expect(JSON.stringify(plan)).not.toMatch(/[0-9a-f]{64}/);
});

test('an encrypted upload is never presigned, whatever the store can do', async () => {
  // A presigned PUT hands the client a URL to the bucket. The client seals nothing now, so
  // honouring one would put PLAINTEXT in the store — the exact thing the encryption exists
  // to prevent.
  class Presigning extends MemoryStorage {
    get capabilities() { return { ...super.capabilities, presignUpload: true }; }
    async presignPut() { return 'https://bucket.example/x'; }
    async presignPart() { return 'https://bucket.example/x?part'; }
  }
  const d = await drive({ storage: new Presigning() });
  const small = await d.uploads.create({ collectionId: d.encrypted.id, name: 'a.txt', size: 10 });
  expect(small.presigned).toBe(false);
  expect(small.url).toBeUndefined();

  // …while an unencrypted collection on the same store still goes straight to the bucket.
  const open = await d.uploads.create({ collectionId: d.open.id, name: 'b.txt', size: 10 });
  expect(open.presigned).toBe(true);
});

test('an unencrypted collection gets no key and says so plainly', async () => {
  // One thing for a client to check, rather than an absent field to interpret.
  const d = await drive();
  const plan = await d.uploads.create({ collectionId: d.open.id, name: 'notes.txt', size: 100 });
  expect(plan.encryption).toBe(null);
});

test('rules decide per item, not per collection', async () => {
  const d = await drive({ rules: { mimeTypes: ['image'] } });
  const photo = await d.uploads.create({ collectionId: d.encrypted.id, name: 'a.png', size: 100, contentType: 'image/png' });
  const text = await d.uploads.create({ collectionId: d.encrypted.id, name: 'a.txt', size: 100, contentType: 'text/plain' });
  expect(photo.encryption).toBeTruthy();
  expect(text.encryption).toBe(null);
});

test('parts are negotiated against what the CLIENT sends, which is the file', async () => {
  // The inverse of what this used to assert. When the browser sealed, what travelled was
  // the envelope and parts had to be sized against it. The drive seals now, so what
  // travels is the file — sizing parts against the envelope would ask a client for bytes
  // it does not have. The stored size still governs the per-file LIMIT, which is measured
  // at both ends.
  const partSize = 5 * 1024 * 1024;
  const storage = new MemoryStorage();
  const d = await drive({ storage });
  d.uploads.partSize = partSize;

  // Sized so the plaintext fits in exactly two parts and the envelope does not.
  const size = partSize * 2;
  const plan = await d.uploads.create({ collectionId: d.encrypted.id, name: 'big.bin', size });
  const stored = cipherSize(size, DEFAULT_CHUNK_SIZE);
  expect(stored).toBeGreaterThan(size);
  expect(plan.partCount).toBe(Math.ceil(size / partSize));
  // And one part FEWER than the envelope would have asked for — which is the whole
  // difference between the two designs.
  expect(plan.partCount).toBeLessThan(Math.ceil(stored / partSize));
});

test('the per-file limit is still measured against what the store will hold', async () => {
  // The envelope is bigger than the file, and `complete` checks the size read back from the
  // store. Measuring the limit against the file at negotiation and the envelope at
  // completion is how a file just under the limit got transferred in full and then deleted.
  const justUnder = 5 * 1024 * 1024;
  const stored = justUnder + HEADER_BYTES + TAG_BYTES * Math.ceil(justUnder / DEFAULT_CHUNK_SIZE);
  const d = await drive({ storage: new MemoryStorage(), maxBytes: stored - 1 });
  await expect(d.uploads.create({ collectionId: d.encrypted.id, name: 'x.bin', size: justUnder }))
    .rejects.toThrow(/storage|limit/i);
});

test('the item keeps the size the user recognises', async () => {
  // The bucket holds more bytes than the file has; the drive should still report the file.
  const d = await drive();
  const plan = await d.uploads.create({ collectionId: d.encrypted.id, name: 'notes.txt', size: 100 });
  const status = await d.uploads.status(plan.uploadId);
  expect(status.uploadId).toBe(plan.uploadId);
  const session = await d.uploads.sessions.get(plan.uploadId);
  expect(session.size).toBe(100);
  expect(session.storedSize).toBe(cipherSize(100, DEFAULT_CHUNK_SIZE));
  expect(session.encrypted).toBe(true);
});

test('whether an item is encrypted is decided once and recorded', async () => {
  // Not re-derived at complete: the collection's rules can change in between, and an
  // object planned as one thing and finished as another is unreadable either way.
  const d = await drive({ rules: { mimeTypes: ['image'] } });
  const plan = await d.uploads.create({ collectionId: d.encrypted.id, name: 'a.png', size: 10, contentType: 'image/png' });
  await d.collections.update(d.encrypted.id, {
    encryption: { enabled: true, rules: { mimeTypes: ['video'] } },
  }, BOSS);
  const session = await d.uploads.sessions.get(plan.uploadId);
  expect(session.encrypted).toBe(true);
});

test('a collection that encrypts refuses the upload when its key is unavailable', async () => {
  // The two implementations of "encrypt this item, and with which key" disagreed in the
  // direction that matters. The upload path answered `null` on a key miss, which made the
  // session PLAINTEXT in a collection someone set up to encrypt — and `#assertSealed`, the
  // guard built to stop exactly that, is gated on `s.encrypted`, so it never ran.
  // `writeFile` throws. There is one implementation now, and it is the one that throws.
  //
  // A ring with no key in it is what a record restored from a backup taken before the key
  // existed looks like — the case the guard was written for.
  const d = await drive();
  const record = await d.collections.get(d.encrypted.id);
  await d.collections.kv.set('collections', d.encrypted.id, { ...record, $keys: {} });

  await expect(d.uploads.create({ collectionId: d.encrypted.id, name: 'notes.txt', size: 100 }))
    .rejects.toThrow(/key is unavailable/);
  // And the write path, which always said so, still does.
  await expect(d.vfs.writeFile('notes.txt', 'plaintext', { collectionId: d.encrypted.id }))
    .rejects.toThrow(/key is unavailable/);
});
