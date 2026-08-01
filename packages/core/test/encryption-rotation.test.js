// Moving a collection onto a new key without anything becoming unreadable.
//
// Rotation cannot be atomic — hundreds of thousands of objects, each read, decrypted,
// re-encrypted and written back — so what matters is what is true at every moment in
// between, including after a crash halfway.

import { test, expect } from 'bun:test';
import {
  createVfs, CollectionService, MemoryKV, MemoryStorage, RotationService,
  encrypt, fromHex, isEnvelope, decodeHeader, fingerprintHex, DEFAULT_CHUNK_SIZE,
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
  // Plaintext, because that is what a client sends now — the drive seals on the way to
  // the store and the key never leaves it.
  await d.vfs.uploads.uploadPart(plan.uploadId, 1, body);
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

// --- large files, which is where this had to work and did not ------------------

/**
 * A multipart-capable store that records the largest single buffer it was ever handed.
 *
 * That number is the whole question: if rotation buffers, it scales with the file, and on a
 * Worker isolate — 128 MB for everything — the ceiling landed somewhere around a 50 MB
 * file, making rotation unavailable for exactly the collections most likely to want it.
 */
class MultipartStore extends MemoryStorage {
  constructor() {
    super();
    this.biggestWrite = 0;
    this.multiparts = new Map();
    this.aborted = [];
  }
  get capabilities() {
    return { ...super.capabilities, multipart: true };
  }
  async createMultipart(key) {
    const id = `mp_${key}`;
    this.multiparts.set(id, []);
    return id;
  }
  async putPart(key, uploadId, partNumber, body) {
    this.biggestWrite = Math.max(this.biggestWrite, body.length);
    this.multiparts.get(uploadId)[partNumber - 1] = body;
    return { etag: `etag${partNumber}` };
  }
  async completeMultipart(key, uploadId) {
    const parts = this.multiparts.get(uploadId).filter(Boolean);
    const total = parts.reduce((n, p) => n + p.length, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { joined.set(p, at); at += p.length; }
    this.multiparts.delete(uploadId);
    return super.put(key, joined);
  }
  async abortMultipart(key, uploadId) {
    this.aborted.push(uploadId);
    this.multiparts.delete(uploadId);
  }
  async put(key, body, opts) {
    this.biggestWrite = Math.max(this.biggestWrite, body.length ?? 0);
    return super.put(key, body, opts);
  }
}

test('a large object rotates without ever being held whole', async () => {
  const kv = new MemoryKV();
  const storage = new MultipartStore();
  const collections = new CollectionService({ kv, storageFactory: () => storage, admins: ['boss'] });
  const c = await collections.create({
    name: 'Big', store: { driver: 'memory' }, encryption: { enabled: true, rules: { all: true } },
  }, BOSS);
  const vfs = await createVfs({ storage, collections });
  const rotation = new RotationService({ kv, vfs, collections });

  // 40 MiB — comfortably past what an isolate could hold twice over.
  const size = 40 * 1024 * 1024;
  const body = new Uint8Array(size);
  for (let i = 0; i < size; i += 4096) body[i] = i % 251;
  // Seeded straight into the store: this test is about the rotation, and routing 40 MiB
  // through the upload machinery would be testing that instead.
  const key = await collections.dataKeyFor(c.id);
  const fp = fromHex(c.encryption.fingerprint);
  const sealed = await encrypt(key, body, { fingerprint: fp, chunkSize: DEFAULT_CHUNK_SIZE });
  await storage.put('obj_big', sealed, { contentType: 'application/octet-stream' });
  const node = await vfs.metadata.create({
    collectionId: c.id, name: 'big.bin', storageKey: 'obj_big', size,
    contentType: 'application/octet-stream',
    encryption: { fingerprint: c.encryption.fingerprint, chunkSize: DEFAULT_CHUNK_SIZE },
  });

  storage.biggestWrite = 0; // measure the rotation, not the upload
  await rotation.begin(c.id, BOSS);
  let state = await rotation.step(c.id);
  while (state.status === 'running') state = await rotation.step(c.id);
  expect(state.moved).toBe(1);
  expect(state.failed).toBe(0);

  // The property: no single write was anywhere near the file. One part, not one file.
  expect(storage.biggestWrite).toBeLessThan(12 * 1024 * 1024);
  expect(storage.biggestWrite).toBeGreaterThan(0);

  // And it still reads back byte for byte.
  const out = new Uint8Array(await new Response((await vfs.readStream(node.id)).stream).arrayBuffer());
  expect(out.length).toBe(size);
  expect(out[0]).toBe(body[0]);
  expect(out[4096]).toBe(body[4096]);
  expect(out[size - 4096]).toBe(body[size - 4096]);
});

test('a multipart that fails partway is aborted, not left in the bucket', async () => {
  // Otherwise the parts already sent stay there, billed, with nothing able to reclaim them.
  const kv = new MemoryKV();
  const storage = new MultipartStore();
  const collections = new CollectionService({ kv, storageFactory: () => storage, admins: ['boss'] });
  const c = await collections.create({
    name: 'Big', store: { driver: 'memory' }, encryption: { enabled: true, rules: { all: true } },
  }, BOSS);
  const vfs = await createVfs({ storage, collections });
  const rotation = new RotationService({ kv, vfs, collections });

  const key = await collections.dataKeyFor(c.id);
  const sealed = await encrypt(key, text('hello'), {
    fingerprint: fromHex(c.encryption.fingerprint), chunkSize: DEFAULT_CHUNK_SIZE,
  });
  await storage.put('obj_x', sealed, { contentType: 'text/plain' });
  const node = await vfs.metadata.create({
    collectionId: c.id, name: 'x.bin', storageKey: 'obj_x', size: 5, contentType: 'text/plain',
    encryption: { fingerprint: c.encryption.fingerprint, chunkSize: DEFAULT_CHUNK_SIZE },
  });
  // Only the rotation's writes fail.
  storage.putPart = async () => { throw new Error('network went away'); };

  await rotation.begin(c.id, BOSS);
  const state = await rotation.step(c.id);
  expect(state.failed).toBe(1);
  expect(storage.aborted.length).toBe(1);
  // The original is untouched, so the file is still there and still readable.
  expect(await new Response((await vfs.readStream(node.id)).stream).text()).toBe('hello');
});

// --- resuming inside one object ------------------------------------------------
//
// A slice is bounded by wall-clock time. Until this worked, an object bigger than the
// budget failed its slice, restarted from the beginning on the next, and failed again —
// forever. A collection with one large video could not be rotated at all, and the old key
// could never retire.

/** A drive holding one object of `size`, already sealed under the collection's first key. */
async function bigDrive(size, { chunkSize = 64 * 1024 } = {}) {
  const kv = new MemoryKV();
  const storage = new MultipartStore();
  const collections = new CollectionService({ kv, storageFactory: () => storage, admins: ['boss'] });
  const c = await collections.create({
    name: 'Big', store: { driver: 'memory' }, encryption: { enabled: true, rules: { all: true } },
  }, BOSS);
  const vfs = await createVfs({ storage, collections });
  const rotation = new RotationService({ kv, vfs, collections });

  const body = new Uint8Array(size);
  for (let i = 0; i < size; i++) body[i] = (i * 7) % 251;
  const key = await collections.dataKeyFor(c.id);
  const sealed = await encrypt(key, body, { fingerprint: fromHex(c.encryption.fingerprint), chunkSize });
  await storage.put('obj_big', sealed, { contentType: 'application/octet-stream' });
  const node = await vfs.metadata.create({
    collectionId: c.id, name: 'big.bin', storageKey: 'obj_big', size,
    contentType: 'application/octet-stream',
    encryption: { fingerprint: c.encryption.fingerprint, chunkSize },
  });
  return { kv, storage, collections, vfs, rotation, c, node, body };
}

test('an object bigger than a slice is resumed, not restarted', async () => {
  // Past PART_TARGET_BYTES (8 MiB), so the object spans parts and a slice can stop
  // inside it. Below that there is nothing to resume — one part is the whole file.
  const d = await bigDrive(20 * 1024 * 1024, { chunkSize: 1024 * 1024 });
  await d.rotation.begin(d.c.id, BOSS);

  // A budget that expires the moment the first part is written, so every slice makes
  // exactly one part of progress and has to hand the rest on.
  let slices = 0;
  let state;
  const expired = () => { slices++; return { now: () => (slices > 1 ? 1e12 : 0), budgetMs: 0 }; };
  for (let i = 0; i < 40; i++) {
    slices = 0;
    state = await d.rotation.step(d.c.id, expired());
    if (state.status !== 'running' || (!state.inflight && state.moved)) break;
  }

  expect(state.moved).toBe(1);
  expect(state.failed).toBe(0);
  expect(state.inflight).toBe(null);

  // The point of the exercise: it took more than one slice, and the object survived it.
  const out = new Uint8Array(await new Response((await d.vfs.readStream(d.node.id)).stream).arrayBuffer());
  expect(out.length).toBe(d.body.length);
  expect(Array.from(out.slice(0, 64))).toEqual(Array.from(d.body.slice(0, 64)));
  expect(Array.from(out.slice(-64))).toEqual(Array.from(d.body.slice(-64)));
  // Every byte, because a nonce sequence that restarted mid-object would decrypt to
  // garbage from the resume point onward rather than fail outright.
  expect(Array.from(out)).toEqual(Array.from(d.body));
});

test('a resumed object carries its envelope position, not a fresh one', async () => {
  // The failure this guards against is silent: a resumed encryption that started a new
  // envelope would reuse nonce/key pairs from the first half — the one thing AES-GCM
  // cannot survive — and the file would still "rotate" successfully.
  const d = await bigDrive(20 * 1024 * 1024, { chunkSize: 1024 * 1024 });
  await d.rotation.begin(d.c.id, BOSS);

  let n = 0;
  const state1 = await d.rotation.step(d.c.id, { budgetMs: 0, now: () => (n++ ? 1e12 : 0) });
  expect(state1.inflight).toBeTruthy();
  expect(state1.inflight.chunkIndex).toBeGreaterThan(0);
  // The prefix travels with the checkpoint — it exists nowhere else once the header is
  // written, and every later slice needs it to continue the sequence.
  expect(typeof state1.inflight.noncePrefix).toBe('string');
  expect(state1.inflight.parts.length).toBeGreaterThan(0);

  let state = state1;
  while (state.status === 'running' && state.inflight) state = await d.rotation.step(d.c.id);
  const out = new Uint8Array(await new Response((await d.vfs.readStream(d.node.id)).stream).arrayBuffer());
  expect(Array.from(out)).toEqual(Array.from(d.body));
});

test('cancelling mid-object spends the half-written upload', async () => {
  // Nothing else can find it: the storage contract has no way to list multiparts, so the
  // checkpoint is the only record that it exists. Left open, S3 bills for it forever.
  const d = await bigDrive(20 * 1024 * 1024, { chunkSize: 1024 * 1024 });
  await d.rotation.begin(d.c.id, BOSS);
  let n = 0;
  const paused = await d.rotation.step(d.c.id, { budgetMs: 0, now: () => (n++ ? 1e12 : 0) });
  expect(paused.inflight).toBeTruthy();
  const orphan = paused.inflight.uploadId;

  await d.rotation.cancel(d.c.id);
  expect(d.storage.aborted).toContain(orphan);
  expect((await d.rotation.state(d.c.id)).inflight).toBe(null);
});

test('an object deleted while a slice was away does not strand its upload', async () => {
  const d = await bigDrive(20 * 1024 * 1024, { chunkSize: 1024 * 1024 });
  await d.rotation.begin(d.c.id, BOSS);
  let n = 0;
  const paused = await d.rotation.step(d.c.id, { budgetMs: 0, now: () => (n++ ? 1e12 : 0) });
  const orphan = paused.inflight.uploadId;

  await d.vfs.metadata.remove(d.node.id);
  const after = await d.rotation.step(d.c.id);
  expect(d.storage.aborted).toContain(orphan);
  expect(after.inflight).toBe(null);
});

test('a rotation key does not accumulate suffixes across rotations', async () => {
  // `${node.storageKey}.rot${...}` appends to the CURRENT key, which after one rotation
  // already carries a suffix. Two rotations produced `obj_x.rotms9gq8j2.rotms9grnhf`, and
  // the key grew by ~11 characters on every rotation forever — S3 refuses a key over 1024
  // bytes, so a drive rotated on a schedule would eventually stop being able to rotate.
  const { rotatedKey } = await import('../src/encryption/rotation.js');
  const first = rotatedKey('obj_abc');
  expect(first).toMatch(/^obj_abc\.rot[0-9a-z]+$/);
  const second = rotatedKey(first);
  expect(second).toMatch(/^obj_abc\.rot[0-9a-z]+$/);
  expect(rotatedKey(second)).toMatch(/^obj_abc\.rot[0-9a-z]+$/);
  // A name that merely contains "rot" is not a suffix and must survive.
  expect(rotatedKey('obj_carrot')).toMatch(/^obj_carrot\.rot[0-9a-z]+$/);
});
