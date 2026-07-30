// Upload sessions have to outlive the process that created one.
//
// An upload is several requests — create, the bytes, complete — joined only by the
// session. Kept in a Map, that holds exactly as long as every request reaches the same
// process. A long-lived server gets away with that; a serverless one does not, and the
// symptom is the worst kind: "Upload session not found" on a drive where nothing is
// wrong, with the session's own 24h TTL nowhere near up.
//
// The isolate boundary is expressible as a unit test — two UploadManagers that share a
// store and share nothing else. That is precisely what two Workers isolates are.

import { test, expect } from 'bun:test';
import { UploadManager, KvSessionStore, MemoryKV, MemoryStorage } from '../src/index.js';

const managerOn = (kv) => new UploadManager({
  storage: new MemoryStorage(),
  sessions: new KvSessionStore({ kv }),
});

test('a session created by one process is completable by another', async () => {
  // The exact failure: `create` on isolate A, `complete` on isolate B.
  const kv = new MemoryKV();
  const a = managerOn(kv);
  const plan = await a.create({ name: 'notes.txt', size: 11, contentType: 'text/plain' });
  expect(plan.uploadId).toBeTruthy();

  const b = managerOn(kv);
  const seen = await b.status(plan.uploadId);
  expect(seen.uploadId).toBe(plan.uploadId);
  expect(seen.received).toEqual([]);
});

test('the in-memory store is exactly what breaks that', async () => {
  // Kept as a test rather than a comment, because it is the behaviour being replaced and
  // it should be visible why a default of memory is not merely slower.
  const a = new UploadManager({ storage: new MemoryStorage() });
  const b = new UploadManager({ storage: new MemoryStorage() });
  const plan = await a.create({ name: 'notes.txt', size: 11, contentType: 'text/plain' });
  await expect(b.status(plan.uploadId)).rejects.toThrow(/Upload session/);
});

test('a part reported on one process is seen by another', async () => {
  // Resume depends on this: the client asks which parts already landed, and an answer of
  // "none" on a fresh isolate means re-uploading gigabytes that are already in the bucket.
  const kv = new MemoryKV();
  const a = managerOn(kv);
  // Large enough to be multipart rather than a single PUT.
  const plan = await a.create({ name: 'big.bin', size: 12 * 1024 * 1024 });
  expect(plan.strategy).not.toBe('single');

  await a.uploadPart(plan.uploadId, 1, new Uint8Array(8 * 1024 * 1024));
  const b = managerOn(kv);
  const status = await b.status(plan.uploadId);
  expect(status.received).toContain(1);
});

test('sessions are plain JSON, because a durable store can only hold that', async () => {
  const kv = new MemoryKV();
  const store = new KvSessionStore({ kv });
  const m = new UploadManager({ storage: new MemoryStorage(), sessions: store });
  const plan = await m.create({ name: 'notes.txt', size: 11 });
  const raw = await kv.get('uploads', plan.uploadId);
  // Round-trips without loss — no Set, no Map, no class instance hiding in there.
  expect(JSON.parse(JSON.stringify(raw))).toEqual(raw);
});

test('expiry reports without deleting, so the multipart can still be aborted', async () => {
  // The session holds the storage-side uploadId, and that is the only handle that can
  // abort the multipart. A store that deleted on expiry would strand the uploaded parts
  // in the bucket, billed, with nothing left able to reclaim them.
  const kv = new MemoryKV();
  const store = new KvSessionStore({ kv });
  await store.put({ id: 'up_old', createdAt: 0 });
  const expired = await store.expired(Date.now());
  expect(expired).toEqual(['up_old']);
  expect(await store.get('up_old')).toBeTruthy();
});

test('a store needs somewhere to store things', async () => {
  expect(() => new KvSessionStore({})).toThrow(/needs a KeyValueStore/);
});
