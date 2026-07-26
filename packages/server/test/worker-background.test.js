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
import worker from '../src/adapters/worker.js';
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
