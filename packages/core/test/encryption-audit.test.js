// Regressions from the audit pass. Each of these was silent, or destructive, or both.

import { test, expect } from 'bun:test';
import {
  createVfs, CollectionService, MemoryKV, MemoryStorage, UploadManager,
  CollectionScanner, RotationService, encrypt, fromHex, cipherSize, isEnvelope,
  describeExposure, DEFAULT_CHUNK_SIZE,
} from '../src/index.js';

const BOSS = { id: 'boss', roles: [] };
const text = (s) => new TextEncoder().encode(s);

async function drive({ maxUploadBytes = null } = {}) {
  const kv = new MemoryKV();
  const storage = new MemoryStorage();
  const collections = new CollectionService({ kv, storageFactory: () => storage, admins: ['boss'] });
  const c = await collections.create({
    name: 'Private', store: { driver: 'memory' }, encryption: { enabled: true, rules: { all: true } },
  }, BOSS);
  const vfs = await createVfs({ storage, collections, maxUploadBytes });
  return { kv, storage, collections, vfs, c };
}
async function put(d, name, body) {
  const plan = await d.vfs.createUpload({ collectionId: d.c.id, name, size: body.length, contentType: 'text/plain' });
  // Plaintext, because that is what a client sends now — the drive seals on the way to
  // the store and the key never leaves it.
  await d.vfs.uploads.uploadPart(plan.uploadId, 1, body);
  return d.vfs.completeUpload(plan.uploadId);
}

test('the size limit is measured against what is stored, at negotiation', async () => {
  // Was: `create` checked the plaintext size and `complete` checked the envelope, so a file
  // just under the limit was accepted, transferred IN FULL, and then deleted by the
  // too-large branch. The user paid for the whole upload and lost the file.
  const overhead = cipherSize(0, DEFAULT_CHUNK_SIZE);
  const limit = 1000;
  const d = await drive({ maxUploadBytes: limit });
  // Plaintext fits; the envelope does not.
  const size = limit - Math.floor(overhead / 2);
  await expect(d.vfs.createUpload({ collectionId: d.c.id, name: 'big.txt', size, contentType: 'text/plain' }))
    .rejects.toThrow(/Encrypted, this file needs/);
  // Refused up front, so nothing was uploaded and nothing was deleted.
  expect((await d.storage.list({})).items?.length ?? 0).toBe(0);
});

test('a file that genuinely fits still uploads', async () => {
  const d = await drive({ maxUploadBytes: 100_000 });
  const done = await put(d, 'ok.txt', text('small enough'));
  expect(done.size).toBe(12);
});

test('the envelope decides which key opens an object, not the item record', async () => {
  // The record is a copy kept for cheap listings, and a copy can be stale — an object from
  // a backup, or adopted by a scan. Deriving ranges from the record and decrypting with the
  // object's real geometry produced "the data has been altered" on data nobody altered.
  const d = await drive();
  const done = await put(d, 'a.txt', text('authoritative'));
  // Corrupt the RECORD's idea of the geometry; the object is untouched.
  await d.vfs.metadata.update(done.id, {
    encryption: { fingerprint: 'ff'.repeat(16), chunkSize: 64 },
  });
  const read = await d.vfs.readStream(done.id);
  expect(await new Response(read.stream).text()).toBe('authoritative');
});

test('an encrypted object copied into the bucket is adopted as encrypted', async () => {
  // Sideloading is a named use case, so it has to be the one that works. Without this the
  // drive lists the file and hands back raw ciphertext with no error at all.
  const d = await drive();
  const key = await d.collections.dataKeyFor(d.c.id);
  const fp = fromHex(d.c.encryption.fingerprint);
  const sealed = await encrypt(key, text('arrived from elsewhere'), { fingerprint: fp, chunkSize: DEFAULT_CHUNK_SIZE });
  await d.storage.put('sideloaded.txt', sealed, { contentType: 'text/plain' });

  const scanner = new CollectionScanner({ vfs: d.vfs });
  await scanner.scan(d.c.id, {});

  const node = await d.vfs.metadata.getByName(d.c.id, 'sideloaded.txt');
  expect(node).toBeTruthy();
  expect(node.encryption?.fingerprint).toBe(d.c.encryption.fingerprint);
  // And it records the size of the FILE, not of the envelope.
  expect(node.size).toBe('arrived from elsewhere'.length);
  expect(await new Response((await d.vfs.readStream(node.id)).stream).text()).toBe('arrived from elsewhere');
});

test('an ordinary file copied in is still adopted as plaintext', async () => {
  const d = await drive();
  await d.storage.put('plain.txt', text('just a file'), { contentType: 'text/plain' });
  const scanner = new CollectionScanner({ vfs: d.vfs });
  await scanner.scan(d.c.id, {});
  const node = await d.vfs.metadata.getByName(d.c.id, 'plain.txt');
  expect(node.encryption).toBe(null);
  expect(await new Response((await d.vfs.readStream(node.id)).stream).text()).toBe('just a file');
});

test('two rotation slices cannot run over each other', async () => {
  // Both would move the same object, and each would delete the object the other replaced —
  // the second delete removing the one the item now points at. Nothing errors; the file is
  // simply gone.
  const d = await drive();
  await put(d, 'a.txt', text('precious'));
  const rotation = new RotationService({ kv: d.kv, vfs: d.vfs, collections: d.collections });
  await rotation.begin(d.c.id, BOSS);

  // Hold the claim, as a slice already in flight would.
  const held = await d.kv.acquire('rotation', d.c.id, 60_000);
  expect(held).toBeTruthy();
  const blocked = await rotation.step(d.c.id);
  expect(blocked.moved).toBe(0); // did nothing rather than racing

  await d.kv.release('rotation', d.c.id, held);
  let state = await rotation.step(d.c.id);
  while (state.status === 'running') state = await rotation.step(d.c.id);
  expect(state.moved).toBe(1);
});

test('exposure with no way to read manifests reports unknown, not safe', async () => {
  // Defaulting to "reaches nowhere" would mean a caller who forgot to wire the reader gets
  // a reassurance nothing checked.
  const e = describeExposure({
    indexers: [{ id: 'trove+contrib:acme.com/x/idx' }],
    plugins: [{ id: 'acme.com/x', manifest: { name: 'x' } }],
  });
  expect(e.indexers[0].endpoints).toBe(null);
  expect(e.anyEgress).toBe(true);
});

test('a client that just sends the file gets a sealed object, not a refusal', async () => {
  // The inverse of what this used to assert, and the point of moving sealing to the drive.
  // Every client that had not implemented encryption sent raw bytes and was REFUSED at
  // completion — correct at the time, because the alternative was plaintext in a bucket the
  // collection claimed was ciphertext. Now sending the file is simply how it is done.
  const d = await drive();
  const plan = await d.vfs.createUpload({
    collectionId: d.c.id, name: 'naive.txt', size: 5, contentType: 'text/plain',
  });
  expect(plan.encryption).toBeTruthy();
  expect(plan.encryption.key).toBeUndefined();
  await d.vfs.uploads.uploadPart(plan.uploadId, 1, text('hello'));
  const node = await d.vfs.completeUpload(plan.uploadId);

  // Sealed under this collection's key, and readable as the file.
  expect(node.encryption?.fingerprint).toBe(d.c.encryption.fingerprint);
  expect(await new Response((await d.vfs.readStream(node.id)).stream).text()).toBe('hello');
  // And what the bucket holds is an envelope, not the text.
  const raw = await new Response((await d.storage.get(node.storageKey)).stream).arrayBuffer();
  expect(isEnvelope(new Uint8Array(raw))).toBe(true);
});

test('a correctly sealed upload still completes', async () => {
  const d = await drive();
  const done = await put(d, 'good.txt', text('hello'));
  expect(done.encryption).toBeTruthy();
  expect(await new Response((await d.vfs.readStream(done.id)).stream).text()).toBe('hello');
});
