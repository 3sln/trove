// Background work on a runtime that can stop running.
//
// `/api/reindex` and `/api/collections/:id/scan` start a task and return immediately —
// the work takes minutes and holding the request open for it would just time out. On a
// long-lived process that is enough: the promise keeps running because the process does.
//
// On Cloudflare Workers it is not. The isolate may be discarded the moment the response
// resolves, so a promise nobody declared is cancelled part-way through — a scan that
// silently did a third of the bucket and reported success. And `setInterval` (how the
// periodic scan and maintenance run everywhere else) does not survive the request it was
// registered in, so on Workers those simply never fire.

import { test, expect } from 'bun:test';
import { MemoryKV, MemoryStorage } from '@3sln/trove/core';

/**
 * Storage whose first `list()` waits until the test lets it go.
 *
 * "Two at once" needs two that are genuinely at once. A memory-backed scan of a
 * handful of objects finishes inside a single turn of the event loop, so
 * starting one and then the other tests them running back to back — which is
 * allowed, and says nothing about the guard.
 */
class GatedStorage extends MemoryStorage {
  constructor() {
    super();
    this.scanning = Promise.withResolvers(); // resolves once a scan is really in flight
    this.gate = Promise.withResolvers();
    this._gated = false;
  }
  open() { this.gate.resolve(); }
  async list(opts) {
    if (!this._gated) {
      this._gated = true;
      this.scanning.resolve();
      await this.gate.promise;
    }
    return super.list(opts);
  }
}
import worker, { getServer } from '../src/adapters/worker.js';
import { createServer, configFromEnv } from '../src/index.js';

const ENV = { TROVE_STORAGE: 'memory' };

test('work a request started is handed to waitUntil', async () => {
  const kept = [];
  const ctx = { waitUntil: (p) => kept.push(p) };
  const res = await worker.fetch(
    new Request('http://t/api/collections/default/scan', { method: 'POST' }), ENV, ctx,
  );
  expect(res.status).toBe(200);
  // Without this the scan is whatever the isolate happened to finish before it died.
  expect(kept.length).toBe(1);
  await Promise.allSettled(kept);
});

test('a request that starts nothing does not call waitUntil', async () => {
  const kept = [];
  await worker.fetch(new Request('http://t/api/health'), ENV, { waitUntil: (p) => kept.push(p) });
  expect(kept.length).toBe(0);
});

test('the cron handler awaits its own work', async () => {
  // `scheduled` gets its own budget and the runtime keeps the isolate alive exactly as
  // long as the promise is pending — so this awaits rather than firing and forgetting.
  let settled = false;
  const ctx = { waitUntil: (p) => p.then(() => { settled = true; }) };
  await worker.scheduled({ cron: '*/5 * * * *' }, ENV, ctx);
  expect(settled).toBe(true);
});

// --- resuming ------------------------------------------------------------------

test('a scan that runs out of budget resumes where it stopped', async () => {
  const server = await createServer(configFromEnv(ENV));
  const { vfs } = server;
  // Objects that arrived without Trove, more than one page of them.
  const storage = await vfs.storageFor('default');
  for (let i = 0; i < 25; i++) {
    await storage.put(`outside-${String(i).padStart(2, '0')}.txt`, new Uint8Array([i]));
  }

  // A budget so small the first slice cannot finish. Before the cursor existed, the
  // only outcomes were "finishes" and "starts from the beginning again, forever".
  const first = await server.startScan('default', { reason: 'slice 1', deadlineMs: -1 });
  expect(first.stopped).toBe(true);

  // Run it to completion the way a cron would: one slice at a time.
  let guard = 0;
  let last = first;
  while (last.stopped && guard++ < 20) {
    last = await server.startScan('default', { reason: `slice ${guard + 1}`, deadlineMs: 5000 });
  }
  expect(last.stopped).toBe(false);
  expect(last.nextCursor).toBe(null);
  // Every object adopted exactly once across the slices — not re-adopted per slice.
  const items = (await vfs.list('default', { limit: 100 })).items;
  expect(items.length).toBe(25);
  expect(new Set(items.map((i) => i.storageKey)).size).toBe(25);
});

// --- claiming ------------------------------------------------------------------

test('two processes cannot scan the same collection at once', async () => {
  // Two isolates, or two containers behind a load balancer: same bucket, same
  // metadata, separate memories. The route's "is one already running?" check consults
  // an in-memory task list, so each of these sees nothing running and starts.
  //
  // What that costs is not duplicated effort, it is a skipped slice of the bucket.
  // Both write the resume cursor; last-writer-wins. Scan A reaches object 900, scan B
  // is at 300 and writes after it, and the next run resumes from 300 — everything A
  // walked past is now behind a cursor nobody will return to.
  const storage = new GatedStorage();
  const shared = { kv: new MemoryKV(), storage };
  const a = await createServer({ ...configFromEnv(ENV), ...shared });
  const b = await createServer({ ...configFromEnv(ENV), ...shared });

  // A is held inside its first list(), so it is unambiguously still scanning.
  const first = a.startScan('default', { reason: 'isolate a' });
  await storage.scanning.promise;
  const second = await b.startScan('default', { reason: 'isolate b' });
  storage.open();

  expect(second.alreadyRunning).toBe(true);
  expect((await first).alreadyRunning).toBeUndefined();
  // And the one that was turned away did nothing at all — it must not have written a
  // cursor, which is the whole point.
  expect(second.scanned).toBe(0);
  expect(second.nextCursor).toBe(null);
});

test('the claim is released, so the next scan is not locked out', async () => {
  const shared = { kv: new MemoryKV(), storage: new MemoryStorage() };
  const a = await createServer({ ...configFromEnv(ENV), ...shared });
  const b = await createServer({ ...configFromEnv(ENV), ...shared });
  await a.startScan('default', { reason: 'first' });
  // A lock nobody ever releases is worse than no lock: the collection would simply
  // stop being scanned, and nothing would say so.
  expect((await b.startScan('default', { reason: 'second' })).alreadyRunning).toBeUndefined();
});

test('the claim is per collection, not drive-wide', async () => {
  // One collection being scanned must not stop every other collection from being
  // scanned — a drive-wide lock would turn a large photo library into a permanent
  // block on everything else.
  const kv = new MemoryKV();
  const server = await createServer({ ...configFromEnv(ENV), kv });
  const held = await kv.acquire('scan-cursor', 'photos', 60_000);
  expect(held).toBeTruthy();
  expect((await server.startScan('default', { reason: 'unrelated' })).alreadyRunning).toBeUndefined();
});

test('a resumed scan does not report the items it has not reached as orphaned', async () => {
  const server = await createServer(configFromEnv(ENV));
  const { vfs } = server;
  for (let i = 0; i < 5; i++) await vfs.writeFile(`mine-${i}.txt`, 'x', { contentType: 'text/plain' });

  // A slice that starts mid-bucket has, by definition, not seen the objects before its
  // cursor. Counting those as orphans would be a false "your files are gone" alarm —
  // the worst thing this subsystem can say.
  const partial = await vfs.scanCollection('default', { cursor: 'some-cursor', shouldStop: () => false });
  expect(partial.orphaned).toBe(0);
  expect(partial.resumed).toBe(true);
});

test('the front-line server and the object\'s own server are different servers', async () => {
  // Two callers want opposite things from one function. `worker.fetch` wants a server
  // that HANDS scans to the Durable Object; the object's own boot wants one that RUNS
  // them. A single cache slot serves whichever asked first — and a delegating server
  // handed back inside the object would have it forward work to itself, forever.
  const namespace = { idFromName: (n) => n, get: () => ({ fetch: async () => new Response('{}') }) };
  const env = { ...ENV, TASKS: namespace };

  const edge = await getServer(env);
  const inside = await getServer(env, undefined, { delegate: false });
  expect(inside).not.toBe(edge);

  // And each is still cached, which is the whole reason this is a module-level map:
  // a Worker isolate builds its server once and reuses it across requests.
  expect(await getServer(env)).toBe(edge);
  expect(await getServer(env, undefined, { delegate: false })).toBe(inside);
});
