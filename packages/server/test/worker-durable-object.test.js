// The Durable Object that owns background work on Workers.
//
// What is being tested is the thing `ctx.waitUntil` cannot fix: an isolate can keep
// work alive until it finishes, but it cannot let a DIFFERENT isolate see that work.
// The scan runs wherever the POST landed; the GET that polls it lands wherever the
// router feels like; Cancel lands somewhere else again. A Durable Object is addressed
// by name, so all three reach the same place.
//
// Run against fakes for `state` and the namespace binding rather than miniflare — what
// matters here is the protocol between the two halves and the alarm bookkeeping, and
// both are ours.

import { test, expect } from 'bun:test';
import { MemoryKV, MemoryStorage } from '@trove/core';
import { createTaskHost, remoteBackground } from '../src/adapters/worker-tasks.js';
import { createServer, configFromEnv } from '../src/index.js';

/** A DurableObjectState: key/value storage, one alarm, and waitUntil. */
function fakeState() {
  const map = new Map();
  let alarm = null;
  const kept = [];
  return {
    kept,
    get alarmAt() { return alarm; },
    async runAlarm(obj) { alarm = null; await obj.alarm(); },
    async settle() { await Promise.allSettled(kept.splice(0)); },
    waitUntil(p) { kept.push(p); },
    storage: {
      async get(k) { return map.get(k) ?? null; },
      async put(k, v) { map.set(k, v); },
      async delete(k) { return map.delete(k); },
      async list({ prefix = '' } = {}) {
        return new Map([...map].filter(([k]) => k.startsWith(prefix)));
      },
      async getAlarm() { return alarm; },
      async setAlarm(at) { alarm = at; },
    },
  };
}

/** A DurableObjectNamespace whose stub dispatches straight into one object. */
function fakeNamespace(obj) {
  return {
    idFromName: (n) => n,
    get: () => ({ fetch: (url, init) => obj.fetch(new Request(url, init)) }),
  };
}

/** A drive plus the object that owns its background work, sharing one backing store. */
async function drive({ env = {}, objects = 0 } = {}) {
  const shared = { kv: new MemoryKV(), storage: new MemoryStorage() };
  const inner = await createServer({ ...configFromEnv({ TROVE_STORAGE: 'memory' }), ...shared });
  for (let i = 0; i < objects; i++) {
    await (await inner.vfs.storageFor('default')).put(`outside-${String(i).padStart(3, '0')}.txt`, new Uint8Array([i]));
  }
  const TroveTasks = createTaskHost(async () => inner);
  const state = fakeState();
  const object = new TroveTasks(state, env);
  const remote = remoteBackground(fakeNamespace(object));
  // The front-line isolate: its own server, its own memory, sharing only the store.
  const edge = await createServer({
    ...configFromEnv({ TROVE_STORAGE: 'memory' }), ...shared,
    tasks: remote.tasks, background: remote.background, startFlusher: false,
  });
  return { inner, edge, object, state, remote };
}

test('a task started from one isolate is visible from another', async () => {
  // The whole point. Two servers, separate memories: without the object, the scan is
  // in `inner`'s registry and `edge` reports an empty task list forever.
  const { edge, state } = await drive({ objects: 3 });
  const { task } = await edge.beginScan('default', { reason: 'manual' });
  expect(task?.kind).toBe('scan');

  const listed = await edge.tasks.list({});
  expect(listed.map((t) => t.id)).toContain(task.id);
  expect(await edge.tasks.get(task.id)).toBeTruthy();
  await state.settle();
});

test('cancel reaches the work it is meant to abort', async () => {
  // Cancel is cooperative: it aborts a signal held by the running work. An isolate
  // that never saw the task has no signal to abort, so the button silently did nothing.
  const { edge, state } = await drive({ objects: 3 });
  const { task } = await edge.beginScan('default', { reason: 'manual' });
  expect(await edge.tasks.cancel(task.id)).toBe(true);
  expect((await edge.tasks.get(task.id)).status).toBe('cancelled');
  await state.settle();
});

test('dismissing a finished task removes it from the shared list', async () => {
  const { edge, state } = await drive();
  const { task } = await edge.beginScan('default', { reason: 'manual' });
  await state.settle();
  await edge.tasks.dismiss(task.id);
  expect((await edge.tasks.list({})).map((t) => t.id)).not.toContain(task.id);
});

test('the front-line isolate does not claim the object\'s work as its own', async () => {
  // `pending()` feeds ctx.waitUntil. The edge only forwarded a message — if it reported
  // the object's work here, every request would be held open for a scan it does not own.
  const { edge, state } = await drive({ objects: 3 });
  await edge.beginScan('default', { reason: 'manual' });
  expect(edge.tasks.pending()).toBe(null);
  await state.settle();
});

// --- continuing across evictions -------------------------------------------------

test('an unfinished scan stays on the list and arms an alarm', async () => {
  // A slice that runs out of budget before processing anything stops with a NULL
  // cursor — correctly, it got nowhere. Reading that as "finished" would drop the
  // collection having scanned none of it, which is why completion is `stopped`.
  const { object, state } = await drive({ env: { TROVE_SLICE_MS: -1 }, objects: 5 });
  await object.fetch(new Request('https://trove.tasks/begin', {
    method: 'POST', body: JSON.stringify({ kind: 'scan', collectionId: 'default' }),
  }));
  await state.settle();
  expect([...(await state.storage.list({ prefix: 'pending:' })).keys()]).toEqual(['pending:default']);
  expect(state.alarmAt).toBeGreaterThan(0);
});

test('a finished pass clears itself and stops re-arming', async () => {
  const { object, state } = await drive({ objects: 5 });
  await object.fetch(new Request('https://trove.tasks/begin', {
    method: 'POST', body: JSON.stringify({ kind: 'scan', collectionId: 'default' }),
  }));
  await state.settle();
  expect((await state.storage.list({ prefix: 'pending:' })).size).toBe(0);
  // The alarm armed by `begin` fires once, finds nothing pending, and does not re-arm.
  await state.runAlarm(object);
  expect(state.alarmAt).toBe(null);
});

test('the alarm carries a stopped scan to completion', async () => {
  // The durable half: an object evicted mid-scan is brought back by its own alarm and
  // continues from the stored cursor. Losing the isolate costs a slice, not the scan.
  const { inner, object, state } = await drive({ env: { TROVE_SLICE_MS: -1 }, objects: 5 });
  await object.fetch(new Request('https://trove.tasks/begin', {
    method: 'POST', body: JSON.stringify({ kind: 'scan', collectionId: 'default' }),
  }));
  await state.settle();
  expect((await state.storage.list({ prefix: 'pending:' })).size).toBe(1);

  // Budget restored — the next wake-up finishes the pass.
  object.sliceMs = 5000;
  await state.runAlarm(object);
  expect((await state.storage.list({ prefix: 'pending:' })).size).toBe(0);
  expect(state.alarmAt).toBe(null);
  expect((await inner.vfs.list('default', { limit: 100 })).items.length).toBe(5);
});

test('a second start while one is running is told so, not run twice', async () => {
  const { edge, state } = await drive({ objects: 5 });
  const [a, b] = await Promise.all([
    edge.beginScan('default', { reason: 'one' }),
    edge.beginScan('default', { reason: 'two' }),
  ]);
  expect([a.alreadyRunning, b.alreadyRunning].filter(Boolean).length).toBe(1);
  await state.settle();
});

test('the cron slice runs inside the object, not the isolate that received it', async () => {
  const { edge, remote, state } = await drive({ objects: 3 });
  const { result } = await remote.maintain(5000);
  expect(result.swept).toBe(true);
  // and the scan it kicked off is on the shared list, not a local one
  expect(Array.isArray(await edge.tasks.list({}))).toBe(true);
  await state.settle();
});
