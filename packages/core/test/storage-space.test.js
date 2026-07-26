// Running out of room.
//
// This is the failure that turns a drive from "working" into "silently rejecting
// everything", and it arrives with no warning unless something is watching. Two halves
// matter: knowing in advance how much is left, and failing in a way that says what
// happened when it finally does.
//
// Where a real small filesystem is available (a tmpfs the test can fill), these run
// against one — the only way to see the actual ENOSPC the kernel produces rather than
// a stubbed error object. Where it isn't, the parts that don't need a full disk still run.

import { test, expect } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createVfs, FilesystemStorage, MemoryStorage, IssueRegistry, MemoryKV,
  TroveError, ErrorCode, isOutOfSpace, wrapError,
} from '../src/index.js';

// A filesystem small enough to fill, if this environment allows mounting one.
const TINY = process.env.TROVE_TEST_TINYFS || '/tmp/tinyfs';
const hasTinyFs = await (async () => {
  try {
    const probe = join(TINY, `.probe-${Math.random().toString(36).slice(2)}`);
    await writeFile(probe, 'x');
    await rm(probe);
    const { statfs } = await import('node:fs/promises');
    const st = await statfs(TINY);
    // Only useful if it is actually small — filling the real disk would be rude.
    return st.blocks * st.bsize < 64 * 1024 * 1024;
  } catch { return false; }
})();

test('a filesystem reports how much room is left, before anything is written', async () => {
  // statfs needs a path that exists, and the root is created lazily on first write. An
  // empty drive is exactly when someone checks capacity, so "unknown" there would be
  // the least useful possible answer.
  const dir = await mkdtemp(join(tmpdir(), 'trove-usage-'));
  try {
    const storage = new FilesystemStorage({ root: join(dir, 'not-created-yet', 'objects') });
    const usage = await storage.usage();
    expect(usage).toBeTruthy();
    expect(usage.total).toBeGreaterThan(0);
    expect(usage.available).toBeGreaterThan(0);
    expect(usage.used).toBe(usage.total - usage.available);
    expect(storage.capabilities.usage).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a store that cannot know says so instead of inventing a number', async () => {
  // An object store has no "space left" — S3 is effectively unbounded and a bucket
  // quota lives outside the API. A UI showing a made-up gauge would be worse than one
  // showing nothing.
  const storage = new MemoryStorage();
  expect(storage.capabilities.usage).toBe(false);
  expect(await storage.usage()).toBe(null);
  const vfs = await createVfs({ storage });
  expect(await vfs.storageUsage('default')).toBe(null);
});

test('out of space is 507 and not retryable; a rate limit is 429 and is', () => {
  // Both are QUOTA, and conflating them is how a client ends up retry-looping against
  // a full disk. 429 means "back off and try again"; retrying a full disk changes
  // nothing and only a human can clear it — that is 507.
  const full = wrapError(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
  expect(full.code).toBe(ErrorCode.QUOTA);
  expect(full.retryable).toBe(false);
  expect(full.status).toBe(507);
  expect(isOutOfSpace(full)).toBe(true);
  // The message is something a person can act on, not the kernel's phrasing.
  expect(full.message).toMatch(/full/i);

  const throttled = new TroveError(ErrorCode.QUOTA, 'Slow down');
  expect(throttled.retryable).toBe(true);
  expect(throttled.status).toBe(429);
  expect(isOutOfSpace(throttled)).toBe(false);
});

test('a user quota and an over-large file are also out-of-space, not generic errors', () => {
  for (const code of ['EDQUOT', 'EFBIG']) {
    const err = wrapError(Object.assign(new Error(code), { code }));
    expect(isOutOfSpace(err)).toBe(true);
    expect(err.status).toBe(507);
  }
});

test('nearly-full raises a warning while writes still succeed', async () => {
  // Warning early is the entire point. By the time writes fail it is too late for the
  // warning to have been useful.
  const issues = new IssueRegistry({ kv: new MemoryKV() });
  // A backend whose free space we control, so the thresholds can be walked without
  // filling a real disk — what's under test is the reporting, not the kernel.
  class Gauge extends MemoryStorage {
    constructor() { super(); this.free = 1_000_000; }
    get capabilities() { return { ...super.capabilities, usage: true }; }
    async usage() { return { total: 1_000_000, available: this.free, used: 1_000_000 - this.free }; }
  }
  const storage = new Gauge();
  const vfs = await createVfs({ storage, issues });

  await vfs.storageUsage('default');
  expect(await issues.list()).toEqual([]); // plenty of room: nothing to say

  storage.free = 30_000; // 3% — under the warning threshold, writes still fine
  await vfs.storageUsage('default');
  let raised = await issues.list();
  expect(raised).toHaveLength(1);
  expect(raised[0].severity).toBe('warning');
  expect(raised[0].title).toMatch(/nearly out of storage/);

  storage.free = 0; // now it is actually full
  await vfs.storageUsage('default');
  raised = await issues.list();
  expect(raised[0].severity).toBe('error');
  expect(raised[0].title).toMatch(/run out of storage/);

  // And it clears itself when space is freed — a warning you can't get rid of by
  // fixing the problem is one people learn to ignore.
  storage.free = 800_000;
  await vfs.storageUsage('default');
  expect(await issues.list()).toEqual([]);
});

test.if(hasTinyFs)('filling a real disk fails clearly, warns, and leaves the drive readable', async () => {
  const root = join(TINY, `full-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(root, { recursive: true });
  const issues = new IssueRegistry({ kv: new MemoryKV() });
  const vfs = await createVfs({ storage: new FilesystemStorage({ root }), issues });
  try {
    let failure = null;
    let wrote = 0;
    for (let i = 0; i < 200 && !failure; i++) {
      try {
        await vfs.writeFile(`f${i}.bin`, 'x'.repeat(100_000), { contentType: 'application/octet-stream' });
        wrote++;
      } catch (err) { failure = err; }
    }
    expect(wrote).toBeGreaterThan(0);
    expect(failure).toBeTruthy();
    // The real kernel ENOSPC, mapped to something a person can read and a client can act on.
    expect(isOutOfSpace(failure)).toBe(true);
    expect(failure.status).toBe(507);
    expect(failure.message).toMatch(/full|quota/i);

    // The condition is recorded, not just thrown at whoever happened to be uploading —
    // the person who needs to know may not be them.
    const raised = await issues.list();
    expect(raised.some((i) => i.kind === 'storage-space')).toBe(true);

    // And the drive still WORKS for everything that isn't a write. A full disk must not
    // take reads and search down with it.
    const listed = await vfs.list('default');
    expect(listed.items.length).toBe(wrote);
    expect((await vfs.search.keywords.search('f1')).length).toBeGreaterThan(0);
    const first = listed.items[0];
    const bytes = await vfs.readStream(first.id);
    expect((await new Response(bytes.stream).text()).length).toBe(100_000);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
