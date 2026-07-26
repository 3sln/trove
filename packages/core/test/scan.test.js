// Reconciling a collection with the bytes actually in its store.
//
// Trove is not the only thing that can write to a bucket, and the failure mode when it
// assumes otherwise is quiet: a file someone else added is simply invisible, and an
// item whose bytes were deleted elsewhere still looks fine until you open it. These
// tests are mostly about the four states an object can be in, and about the one
// asymmetry that matters — adopting is automatic, deleting never is.

import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVfs, MemoryStorage, FilesystemStorage, IssueRegistry, MemoryKV, StorageBackend } from '../src/index.js';

const drive = async () => {
  const issues = new IssueRegistry({ kv: new MemoryKV() });
  const storage = new MemoryStorage();
  const vfs = await createVfs({ storage, issues });
  return { vfs, storage, issues };
};
const names = async (vfs) => (await vfs.list('default')).items.map((i) => i.name).sort();

test('an object that arrived without us is adopted, and is immediately findable', async () => {
  const { vfs, storage } = await drive();
  await vfs.writeFile('mine.md', '# Written through Trove', { contentType: 'text/markdown' });
  // Someone drags a folder into the bucket with the S3 console.
  await storage.put('holiday/2019/beach.jpg', 'JPEGDATA', { contentType: 'image/jpeg' });
  await storage.put('notes from phil.txt', 'Phil says the melange is ready', { contentType: 'text/plain' });

  const result = await vfs.scanCollection('default');
  expect(result).toMatchObject({ adopted: 2, refreshed: 0, orphaned: 0, failed: 0 });
  expect(await names(vfs)).toEqual(['holiday/2019/beach.jpg', 'mine.md', 'notes from phil.txt']);
  // The key becomes the name — `holiday/2019/beach.jpg` is what a human called it, and
  // flattening it to `beach.jpg` would collide with every other year's.
  // An adopted item nobody can search for is barely an item in a drive with no folders.
  expect((await vfs.search.search('melange')).length).toBeGreaterThan(0);
});

test('scanning twice adopts nothing the second time', async () => {
  const { vfs, storage } = await drive();
  await storage.put('report.txt', 'x', { contentType: 'text/plain' });
  await vfs.scanCollection('default');
  expect(await vfs.scanCollection('default')).toMatchObject({ adopted: 0, refreshed: 0 });
  expect(await names(vfs)).toEqual(['report.txt']);
});

test('bytes replaced in place are re-read and re-indexed', async () => {
  const { vfs, storage } = await drive();
  await storage.put('paper.txt', 'the original contents', { contentType: 'text/plain' });
  await vfs.scanCollection('default');
  const before = (await vfs.list('default')).items[0];

  await storage.put('paper.txt', 'something completely different and much longer now', { contentType: 'text/plain' });
  expect(await vfs.scanCollection('default')).toMatchObject({ adopted: 0, refreshed: 1 });
  const after = await vfs.stat(before.id);
  expect(after.size).not.toBe(before.size);
  expect(after.etag).not.toBe(before.etag);
});

test('bytes deleted elsewhere are REPORTED, never deleted from the drive', async () => {
  // The asymmetry at the heart of this: adopting is additive and reversible, but
  // removing an item because a LIST call didn't mention it is neither — and listing is
  // exactly the call that goes wrong in interesting ways (a wrong prefix, a stale
  // replica, a credential scoped elsewhere).
  const { vfs, storage, issues } = await drive();
  const node = await vfs.writeFile('precious.txt', 'irreplaceable', { contentType: 'text/plain' });
  await storage.delete(node.storageKey);

  const result = await vfs.scanCollection('default');
  expect(result.orphaned).toBe(1);
  expect(await names(vfs)).toEqual(['precious.txt']); // still there
  const raised = await issues.list();
  expect(raised).toHaveLength(1);
  expect(raised[0].kind).toBe('orphaned');
  expect(raised[0].title).toMatch(/no longer in the store/);
  expect(raised[0].severity).toBe('warning');
});

test('a restored file clears the orphan report on the next scan', async () => {
  const { vfs, storage, issues } = await drive();
  const node = await vfs.writeFile('precious.txt', 'irreplaceable', { contentType: 'text/plain' });
  await storage.delete(node.storageKey);
  await vfs.scanCollection('default');
  expect(await issues.list()).toHaveLength(1);

  await storage.put(node.storageKey, 'irreplaceable', { contentType: 'text/plain' });
  await vfs.scanCollection('default');
  expect(await issues.list()).toEqual([]);
});

test('an interrupted scan reports no orphans at all', async () => {
  // A scan cut short has simply not looked at the rest of the bucket. Calling the
  // unvisited items orphaned would be a false alarm about data loss — the worst kind of
  // wrong, because the honest response to it is panic.
  const { vfs, storage } = await drive();
  for (let i = 0; i < 5; i++) await vfs.writeFile(`f${i}.txt`, 'x', { contentType: 'text/plain' });
  let seen = 0;
  const result = await vfs.scanCollection('default', { shouldStop: () => ++seen > 2 });
  expect(result.stopped).toBe(true);
  expect(result.orphaned).toBe(0);
});

test('Trove\'s own leftover blobs are not adopted as documents', async () => {
  // An `obj_<hex>` with no metadata row is a leftover from an interrupted write, not a
  // file someone put there. Adopting it would surface `obj_9fc0…` as a document.
  const { vfs, storage } = await drive();
  await storage.put('obj_deadbeefcafe', 'orphaned blob', { contentType: 'text/plain' });
  const result = await vfs.scanCollection('default');
  expect(result.adopted).toBe(0);
  expect(await names(vfs)).toEqual([]);
});

test('Trove\'s own bookkeeping prefixes are skipped', async () => {
  const { vfs, storage } = await drive();
  await storage.put('sidecars/itm_1.json', '{}', { contentType: 'application/json' });
  await storage.put('packages/plg_1.zip', 'PK', { contentType: 'application/zip' });
  await storage.put('real-file.txt', 'x', { contentType: 'text/plain' });
  const result = await vfs.scanCollection('default');
  expect(result.skipped).toBe(2);
  expect(await names(vfs)).toEqual(['real-file.txt']);
});

test('an adopted name that collides is disambiguated rather than dropped', async () => {
  const { vfs, storage } = await drive();
  await vfs.writeFile('notes.txt', 'the Trove-written one', { contentType: 'text/plain' });
  // A different object that happens to be keyed the same as an existing item's name.
  await storage.put('notes.txt', 'the bucket one', { contentType: 'text/plain' });
  const result = await vfs.scanCollection('default');
  expect(result.adopted).toBe(1);
  expect(await names(vfs)).toEqual(['notes (1).txt', 'notes.txt']);
});

test('a backend that cannot list says so instead of reporting an empty drive', async () => {
  // Silently succeeding with zero objects would mark every item in the collection as
  // orphaned — a scan that reports total data loss because it couldn't look.
  class Blind extends StorageBackend {
    get capabilities() { return { presignDownload: false, presignUpload: false, multipart: false, range: false, list: false }; }
    async put() { return { size: 0 }; }
  }
  const vfs = await createVfs({ storage: new Blind() });
  await expect(vfs.scanCollection('default')).rejects.toThrow(/cannot list/);
});

test('a scan of an unchanged filesystem drive changes nothing', async () => {
  // The etag a listing reports has to be computed the SAME WAY as the one `put`
  // recorded, or every object looks modified and the scan re-reads and re-indexes the
  // whole drive. It did: 3,005 files, 34 seconds, "3005 changed", nothing actually
  // different. Two encodings of the same facts (decimal vs hex) was all it took.
  const dir = await mkdtemp(join(tmpdir(), 'trove-fsscan-'));
  try {
    const vfs = await createVfs({ storage: new FilesystemStorage({ root: dir }) });
    for (let i = 0; i < 5; i++) {
      await vfs.writeFile(`f${i}.txt`, `contents ${i}`, { contentType: 'text/plain' });
    }
    const first = await vfs.scanCollection('default');
    expect(first).toMatchObject({ adopted: 0, refreshed: 0, orphaned: 0, failed: 0 });

    // …and it still notices a real change.
    const node = await vfs.metadata.getByName('default', 'f0.txt');
    const storage = await vfs.storageFor('default');
    await storage.put(node.storageKey, 'completely different contents now', { contentType: 'text/plain' });
    expect(await vfs.scanCollection('default')).toMatchObject({ refreshed: 1, adopted: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a stray file is counted once, not once per page', async () => {
  // `unaddressable` describes the whole tree, so a paged listing must not repeat it —
  // a caller that sums pages would multiply it by the page count. One stray file in a
  // 3,000-object drive was reported as seven.
  const dir = await mkdtemp(join(tmpdir(), 'trove-stray-'));
  try {
    const storage = new FilesystemStorage({ root: dir });
    const vfs = await createVfs({ storage });
    for (let i = 0; i < 12; i++) await vfs.writeFile(`f${i}.txt`, 'x', { contentType: 'text/plain' });
    // A file copied straight into the data directory, not at the path its name maps to.
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'objects'), { recursive: true });
    await writeFile(join(dir, 'objects', 'dropped-here.md'), '# copied in by hand');

    // Force several pages over the same tree.
    let total = 0;
    let cursor = null;
    do {
      const page = await storage.list({ cursor, limit: 5 });
      total += page.unaddressable || 0;
      cursor = page.nextCursor;
    } while (cursor);
    expect(total).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
