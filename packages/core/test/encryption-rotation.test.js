// Moving a collection onto a new key without anything becoming unreadable.
//
// Rotation cannot be atomic — hundreds of thousands of objects, each read, decrypted,
// re-encrypted and written back — so what matters is what is true at every moment in
// between, including after a crash halfway.

import { test, expect } from 'bun:test';
import {
  createVfs, CollectionService, MemoryKV, MemoryStorage, RotationService,
  encrypt, fromHex, isEnvelope, decodeHeader, fingerprintHex,
} from '../src/index.js';

const BOSS = { id: 'boss', roles: [] };
const text = (s) => new TextEncoder().encode(s);

async function drive() {
  const kv = new MemoryKV();
  const storage = new MemoryStorage();
  const collections = new CollectionService({ kv, storageFactory: () => storage, admins: ['boss'] });
  const c = await collections.create({
    name: 'Private', store: { driver: 'memory' }, encryption: { enabled: true, rules: { all: true } },
  }, BOSS);
  const vfs = await createVfs({ storage, collections });
  const rotation = new RotationService({ kv, vfs, collections });
  return { kv, storage, collections, vfs, rotation, c };
}

async function put(d, name, body) {
  const plan = await d.vfs.createUpload({ collectionId: d.c.id, name, size: body.length, contentType: 'text/plain' });
  const sealed = plan.encryption
    ? await encrypt(fromHex(plan.encryption.key), body, {
      fingerprint: fromHex(plan.encryption.fingerprint), chunkSize: plan.encryption.chunkSize,
    })
    : body;
  await d.vfs.uploads.uploadPart(plan.uploadId, 1, sealed);
  return d.vfs.completeUpload(plan.uploadId);
}
const readBack = async (d, id) => new Response((await d.vfs.readStream(id)).stream).text();

test('everything stays readable at every point during a rotation', async () => {
  // The property that matters most. Two keys are live from the moment the rotation starts,
  // so nothing is unreadable partway — including after a crash.
  const d = await drive();
  const a = await put(d, 'a.txt', text('first file'));
  const b = await put(d, 'b.txt', text('second file'));

  await d.rotation.begin(d.c.id, BOSS);
  // Before a single object has moved, both still open.
  expect(await readBack(d, a.id)).toBe('first file');
  expect(await readBack(d, b.id)).toBe('second file');

  await d.rotation.step(d.c.id);
  expect(await readBack(d, a.id)).toBe('first file');
  expect(await readBack(d, b.id)).toBe('second file');
});

test('a rotation moves every object onto the new key and then retires the old one', async () => {
  const d = await drive();
  const before = d.c.encryption.fingerprint;
  const a = await put(d, 'a.txt', text('first file'));
  expect(a.encryption.fingerprint).toBe(before);

  const started = await d.rotation.begin(d.c.id, BOSS);
  // Run to completion the way a cron would.
  let state = await d.rotation.step(d.c.id);
  while (state.status === 'running') state = await d.rotation.step(d.c.id);

  expect(state.moved).toBeGreaterThan(0);
  expect(state.failed).toBe(0);
  const moved = await d.vfs.metadata.getById(a.id);
  expect(moved.encryption.fingerprint).toBe(started.to);
  // The old key is gone from the ring, by observation rather than by counting.
  expect(await d.collections.dataKeyFor(d.c.id, before)).toBe(null);
  // And the file still reads.
  expect(await readBack(d, a.id)).toBe('first file');
});

test('uploads during a rotation are already on the new key', async () => {
  // `beginRotation` makes the new key current before any object moves, so the job only
  // ever has a shrinking set to chase.
  const d = await drive();
  const started = await d.rotation.begin(d.c.id, BOSS);
  const during = await put(d, 'during.txt', text('arrived mid-rotation'));
  expect(during.encryption.fingerprint).toBe(started.to);
});

test('a slice can stop anywhere and the next one continues', async () => {
  // The process doing the work can vanish between slices. Progress is in the KV store, so
  // the next slice picks up rather than starting over.
  const d = await drive();
  for (let i = 0; i < 5; i++) await put(d, `f${i}.txt`, text(`file ${i}`));
  await d.rotation.begin(d.c.id, BOSS);

  // A budget of zero does the smallest amount of work it can and yields.
  const first = await d.rotation.step(d.c.id, { budgetMs: 0 });
  expect(first.status).toBe('running');

  let state = first;
  while (state.status === 'running') state = await d.rotation.step(d.c.id, { budgetMs: 0 });
  expect(state.moved).toBe(5);
  for (let i = 0; i < 5; i++) {
    const n = await d.vfs.metadata.getByName(d.c.id, `f${i}.txt`);
    expect(await readBack(d, n.id)).toBe(`file ${i}`);
  }
});

test('re-running a slice that already ran is free, not destructive', async () => {
  // Idempotent by construction: an object already on the current key is skipped, so a
  // retried slice does no work rather than re-encrypting something twice.
  const d = await drive();
  const a = await put(d, 'a.txt', text('once'));
  await d.rotation.begin(d.c.id, BOSS);
  let state = await d.rotation.step(d.c.id);
  while (state.status === 'running') state = await d.rotation.step(d.c.id);
  const movedCount = state.moved;

  // Another pass over a finished collection.
  const again = await d.rotation.step(d.c.id);
  expect(again.moved).toBe(movedCount);
  expect(await readBack(d, a.id)).toBe('once');
});

test('the bucket really does hold the new ciphertext afterwards', async () => {
  const d = await drive();
  const a = await put(d, 'a.txt', text('secret contents'));
  const started = await d.rotation.begin(d.c.id, BOSS);
  let state = await d.rotation.step(d.c.id);
  while (state.status === 'running') state = await d.rotation.step(d.c.id);

  const node = await d.vfs.metadata.getById(a.id);
  const raw = await d.storage.get(node.storageKey);
  const stored = new Uint8Array(await new Response(raw.stream).arrayBuffer());
  expect(isEnvelope(stored)).toBe(true);
  expect(fingerprintHex(decodeHeader(stored).fingerprint)).toBe(started.to);
  expect(new TextDecoder().decode(stored)).not.toContain('secret contents');
});

test('two rotations cannot run over each other', async () => {
  // Two walkers on one collection would fight over the cursor and neither would know what
  // the other had done.
  const d = await drive();
  await d.rotation.begin(d.c.id, BOSS);
  await expect(d.rotation.begin(d.c.id, BOSS)).rejects.toThrow(/already running/);
});

test('an unencrypted collection has nothing to rotate', async () => {
  const d = await drive();
  const open = await d.collections.create({ name: 'Open', store: { driver: 'memory' } }, BOSS);
  await expect(d.rotation.begin(open.id, BOSS)).rejects.toThrow(/not encrypted/);
});

test('a cancelled rotation leaves what moved moved, and stays readable', async () => {
  const d = await drive();
  const a = await put(d, 'a.txt', text('still fine'));
  await d.rotation.begin(d.c.id, BOSS);
  await d.rotation.cancel(d.c.id);
  expect((await d.rotation.state(d.c.id)).cancelled).toBe(true);
  // Both keys are still live, so nothing broke.
  expect(await readBack(d, a.id)).toBe('still fine');
});
