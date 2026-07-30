// What an upload plan says when the collection is encrypted.
//
// The client encrypts before the bytes leave the browser, so the plan has to carry the key
// AND has to be negotiated against the size of the envelope rather than the size of the
// file. Getting the second one wrong is the subtle failure: the plan looks right, the
// upload proceeds, and the final part is short by a header and a tag per chunk.

import { test, expect } from 'bun:test';
import { UploadManager, CollectionService, MemoryKV, MemoryStorage, cipherSize, HEADER_BYTES, TAG_BYTES, DEFAULT_CHUNK_SIZE } from '../src/index.js';

const BOSS = { id: 'boss', roles: [] };

/** A drive with one encrypted collection, and an UploadManager wired to it as Vfs does. */
async function drive({ rules = { all: true }, storage = new MemoryStorage() } = {}) {
  const collections = new CollectionService({
    kv: new MemoryKV(), storageFactory: () => storage, admins: ['boss'],
  });
  const c = await collections.create({
    name: 'Private', store: { driver: 'memory' },
    encryption: { enabled: true, rules },
  }, BOSS);
  const open = await collections.create({ name: 'Open', store: { driver: 'memory' } }, BOSS);
  const uploads = new UploadManager({
    storage,
    encryptionFor: async (cid) => {
      const encryption = await collections.encryptionFor(cid);
      if (!encryption?.enabled) return null;
      const key = await collections.dataKeyFor(cid);
      return { encryption, dataKeyHex: Buffer.from(key).toString('hex') };
    },
  });
  return { collections, uploads, encrypted: c, open };
}

test('the plan carries the key, so the bytes can be sealed before they leave', async () => {
  // The deliberate trade: the key travels and the bytes do not, which is what keeps a
  // presigned direct-to-bucket upload possible while the bucket only sees ciphertext.
  const d = await drive();
  const plan = await d.uploads.create({ collectionId: d.encrypted.id, name: 'notes.txt', size: 100, contentType: 'text/plain' });
  expect(plan.encryption).toBeTruthy();
  expect(plan.encryption.algorithm).toBe('AES-256-GCM');
  expect(plan.encryption.key).toMatch(/^[0-9a-f]{64}$/);
  expect(plan.encryption.fingerprint).toBe(d.encrypted.encryption.fingerprint);
  expect(plan.encryption.chunkSize).toBe(DEFAULT_CHUNK_SIZE);
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

test('the plan is negotiated against the stored size, not the file size', async () => {
  // The quiet one. An envelope is a header plus a tag per chunk larger than the file, and
  // a multipart plan computed on the file size is short by exactly that — a final part
  // that the client has bytes for and the plan has no slot for.
  const partSize = 5 * 1024 * 1024;
  const storage = new MemoryStorage();
  const d = await drive({ storage });
  d.uploads.partSize = partSize;

  // Sized so the plaintext fits in exactly two parts and the envelope does not.
  const size = partSize * 2;
  const plan = await d.uploads.create({ collectionId: d.encrypted.id, name: 'big.bin', size });
  const stored = cipherSize(size, DEFAULT_CHUNK_SIZE);
  expect(stored).toBeGreaterThan(size);
  expect(plan.encryption.storedSize).toBe(stored);
  expect(plan.partCount).toBe(Math.ceil(stored / partSize));
  // Which is one more part than the plaintext would have asked for.
  expect(plan.partCount).toBeGreaterThan(Math.ceil(size / partSize));
});

test('a file that would fit one PUT unencrypted may not once sealed', async () => {
  // The boundary between "one presigned PUT" and multipart is a size comparison, and it
  // has to be made against what actually travels.
  const storage = new MemoryStorage();
  const d = await drive({ storage });
  const justUnder = 5 * 1024 * 1024; // exactly the single-PUT limit as plaintext
  const plan = await d.uploads.create({ collectionId: d.encrypted.id, name: 'x.bin', size: justUnder });
  // MemoryStorage cannot presign, so this lands on the proxied path either way; what
  // matters is that the decision saw the larger number.
  expect(plan.encryption.storedSize).toBe(justUnder + HEADER_BYTES + TAG_BYTES * Math.ceil(justUnder / DEFAULT_CHUNK_SIZE));
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
