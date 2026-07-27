// SPIKE: what the scan route gains by being an ngin action.
//
// The 409 tests that already existed are the check that nothing changed. These
// are the check that something was gained — three things the hand-written
// version could not do, or did by hand and got wrong once.

import { test, expect } from 'bun:test';
import { MemoryKV, MemoryStorage, StorageBackend } from '@trove/core';
import { createServer, configFromEnv } from '../src/index.js';
import { createScanEngine, ScanCollection } from '../src/engine/index.js';

const ENV = { TROVE_STORAGE: 'memory' };

async function drive({ objects = 0, storage = new MemoryStorage() } = {}) {
  const server = await createServer({ ...configFromEnv(ENV), storage, kv: new MemoryKV() });
  const store = await server.vfs.storageFor('default');
  for (let i = 0; i < objects; i++) {
    await store.put(`outside-${String(i).padStart(3, '0')}.txt`, new Uint8Array([i]));
  }
  return server;
}

/** Storage that reports one object per page, so a scan takes several turns. */
class SlowStorage extends MemoryStorage {
  async list(opts) {
    const page = await super.list({ ...opts, limit: 1 });
    await new Promise((resolve) => setTimeout(resolve));
    return page;
  }
}

test('progress arrives on the feed, not only in the task registry', async () => {
  // Clients poll /api/tasks for progress today, which is a hand-rolled event
  // stream. The same numbers are now on a feed an SSE endpoint could subscribe
  // to — the point being that it is one mechanism rather than a second one.
  const server = await drive({ objects: 4 });
  const { feed, done } = await server.beginScan('default', { reason: 'spike' });
  const seen = [];
  feed.addEventListener('progress', (event) => seen.push(event.scanned));
  await done;
  expect(seen.length).toBeGreaterThan(0);
  // Monotonic, and ending where the scan ended.
  expect(seen).toEqual([...seen].sort((a, b) => a - b));
  expect(seen.at(-1)).toBe(4);
});

test('the caller can abort a scan through the feed', async () => {
  // A cancellation the TaskRegistry knows nothing about: the caller gave up.
  // Before, the only stop signals were `closing` and a Cancel click.
  const server = await drive({ objects: 20, storage: new SlowStorage() });
  const { feed, done } = await server.beginScan('default', { reason: 'spike' });
  await new Promise((resolve) => feed.addEventListener('progress', resolve, { once: true }));
  feed.abort(new Error('client disconnected'));

  const result = await done;
  expect(result.stopped).toBe(true);
  expect(result.scanned).toBeLessThan(20);
});

test('an aborted scan releases its claim, so the next one can run', async () => {
  const server = await drive({ objects: 20, storage: new SlowStorage() });
  const { feed, done } = await server.beginScan('default', { reason: 'first' });
  await new Promise((resolve) => feed.addEventListener('progress', resolve, { once: true }));
  feed.abort();
  await done;

  const second = await server.beginScan('default', { reason: 'second' });
  expect(second.alreadyRunning).toBe(false);
  await second.done;
});

test('a scan that throws still releases its claim', async () => {
  // This is the container's job now. The hand-written try/finally released the
  // claim as soon as the function returned rather than when the work ended —
  // written once, wrong once.
  const server = await drive();
  const boom = new Error('the store fell over');
  const real = server.vfs.scanCollection.bind(server.vfs);
  server.vfs.scanCollection = async () => { throw boom; };

  await expect(server.startScan('default', { reason: 'doomed' })).rejects.toThrow('the store fell over');

  server.vfs.scanCollection = real;
  const after = await server.beginScan('default', { reason: 'after' });
  expect(after.alreadyRunning).toBe(false);
  await after.done;
});

test('an action declares what it touches, and gets only that', async () => {
  // The 18-key context object every route receives today is a service locator:
  // nothing says which parts a given route uses, so nothing stops it reaching
  // for more. A declared dependency list is the answer, and it is checkable.
  expect(ScanCollection.deps).toEqual(['vfs', 'tasks', 'lifecycle']);
  const action = new ScanCollection({ collectionId: 'photos' });
  expect(action.deps).toEqual({ claim: { collectionId: 'photos' } });
});

test('a dependency the container does not have fails by name', async () => {
  // Not `undefined is not a function` from somewhere inside a scan: the graph
  // is declared, so an unsatisfiable one says which name it could not find.
  const engine = createScanEngine({ vfs: {}, tasks: {}, kv: new MemoryKV() });
  const stray = new (class extends (await import('@3sln/ngin')).Action {
    static deps = ['nonesuch'];
    execute() {}
  })();
  await expect(engine.dispatch(stray).next(['complete'])).rejects.toThrow(/nonesuch/);
});

test('storage is still the pluggable seam it was', async () => {
  // Nothing about moving to a container changes what a deployment can swap.
  const storage = new SlowStorage();
  expect(storage).toBeInstanceOf(StorageBackend);
  const server = await drive({ objects: 2, storage });
  expect((await server.startScan('default', { reason: 'spike' })).scanned).toBe(2);
});
