// The round-2 audit findings, as tests. Every one of these passed before the fix in the
// sense that nothing threw — they are all cases where the wrong answer looked exactly
// like the right one.

import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createVfs, MemoryStorage, MemoryStore, FilesystemStorage, PrefixedStorage,
  SidecarManager, CollectionScanner, sidecarOps,
} from '../src/index.js';

// --- the scan must not resurrect what the trash is holding ---------------------

test('a scan leaves a trashed file alone instead of adopting it a second time', async () => {
  const storage = new MemoryStorage();
  const vfs = await createVfs({ storage });
  const scanner = new CollectionScanner({ vfs });

  // A file that arrived without Trove, then got adopted.
  await storage.put('holiday.jpg', new Uint8Array([1, 2, 3]), { contentType: 'image/jpeg' });
  expect((await scanner.scan('default', { adopt: true })).adopted).toBe(1);
  const adopted = await vfs.metadata.getByName('default', 'holiday.jpg');

  // Deleting is a SOFT delete: the row keeps its storageKey and the bytes stay, which
  // is what makes it undoable.
  await vfs.remove(adopted.id);

  // The second scan used to see an object with no LIVE row behind it — `listItems`
  // excludes the trash — and adopt it again: the deleted file back in the drive, under
  // a new id sharing the original's storage key. Emptying the trash then deleted the
  // live copy's bytes.
  const again = await scanner.scan('default', { adopt: true });
  expect(again.adopted).toBe(0);
  expect(again.orphaned).toBe(0);
  expect((await vfs.list('default')).items.map((i) => i.name)).toEqual([]);

  // And the bytes are still there for a restore.
  await vfs.metadata.restore(adopted.id);
  expect(await vfs.readStream(adopted.id)).toBeTruthy();
});

// --- a comment accepted mid-flush must survive ---------------------------------

test('a comment written while the sidecar is saving is not silently dropped', async () => {
  // A store with real latency, because that is what object storage is — and the race
  // needs a window. The first flush of a document is immune (the cold copy is null, so
  // the merged doc IS the live one), so this comments once and flushes first.
  const { docs, store } = slowStore(40, 80);
  const mgr = new SidecarManager({ store, flushDelayMs: 5 });

  await mgr.mutate('n1', (d) => addComment(d, 'c1'));
  await mgr.flush('n1');

  await mgr.mutate('n1', (d) => addComment(d, 'c2'));
  const inFlight = mgr.flush('n1');
  await sleep(60); // inside store.save(), after the merge was computed
  await mgr.mutate('n1', (d) => addComment(d, 'c3'));
  await inFlight;

  // `e.doc = merged` used to discard c3 from memory, and `e.dirty = false` guaranteed
  // it would never be written — after the API had already replied 200.
  expect(ids(await mgr.get('n1'))).toEqual(['c1', 'c2', 'c3']);
  await mgr.flush('n1');
  expect(ids(docs.get('n1'))).toEqual(['c1', 'c2', 'c3']);
});

test('overlapping flushes of one document do not race each other', async () => {
  const { docs, store } = slowStore(20, 40);
  const mgr = new SidecarManager({ store, flushDelayMs: 5 });
  await mgr.mutate('n', (d) => addComment(d, 'a'));
  await mgr.flush('n');
  await mgr.mutate('n', (d) => addComment(d, 'b'));
  await Promise.all([mgr.flush('n'), mgr.flush('n'), mgr.flush('n')]);
  expect(ids(docs.get('n'))).toEqual(['a', 'b']);
});

// --- a filesystem key must survive the round trip ------------------------------

test('a prefixed filesystem collection can list its own objects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trove-fs-'));
  try {
    const inner = new FilesystemStorage({ root });
    const storage = new PrefixedStorage(inner, 'team-a');
    await storage.put('obj_one', new Uint8Array([1]));
    await storage.put('holiday/2019/beach.jpg', new Uint8Array([2]));

    // Keys were mangled into filenames irreversibly, so `list()` could only report the
    // mangled name — which never matches the `team-a/` prefix. The result was an empty
    // listing and, through the scanner, a durable "3 items point at files that are no
    // longer in the store" warning on a drive where nothing was wrong.
    const listed = await storage.list({});
    expect(listed.objects.map((o) => o.key).sort()).toEqual(['holiday/2019/beach.jpg', 'obj_one']);

    // And the bytes are still addressable by the key that came back.
    for (const o of listed.objects) expect((await storage.head(o.key)).size).toBeGreaterThan(0);

    // Prefixes are the wrapper's whole job, so a sibling collection must not see these.
    const other = new PrefixedStorage(inner, 'team-b');
    expect((await other.list({})).objects).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a filesystem key made only of safe characters keeps its old filename', async () => {
  // Trove mints `obj_<hex>`, so the encoding must be the identity for those — otherwise
  // this would be a migration rather than a fix.
  const root = await mkdtemp(join(tmpdir(), 'trove-fs-'));
  try {
    const storage = new FilesystemStorage({ root });
    await storage.put('obj_deadbeef', new Uint8Array([7]));
    const { objects } = await storage.list({});
    expect(objects.map((o) => o.key)).toEqual(['obj_deadbeef']);
    expect((await storage.usage())).toBeTruthy();
    // …and through a prefix, free space still answers.
    expect(await new PrefixedStorage(storage, 'x').usage()).toBeTruthy();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- uploads -------------------------------------------------------------------

test('completing an upload whose bytes were never written is refused', async () => {
  // A backend with neither multipart nor presign, so the plan is 'direct-single' —
  // one whole-object PUT, and nothing else that would notice it never arrived. (The
  // multipart strategies are already safe: `complete` demands every part's etag.)
  class SimpleStorage extends MemoryStorage {
    get capabilities() { return { ...super.capabilities, multipart: false, presignUpload: false }; }
  }
  const vfs = await createVfs({ storage: new SimpleStorage() });
  const plan = await vfs.createUpload({ name: 'ghost.txt', size: 1024 });
  expect(plan.strategy).toBe('direct-single');
  // No part is ever uploaded — a presigned PUT that expired, a dropped connection, or
  // simply a client that skipped it. The size check swallowed NOT_FOUND and committed
  // an item for an object that does not exist: listed at a size the client invented,
  // downloading to a 404, raising a standing index issue forever.
  await expect(vfs.completeUpload(plan.uploadId)).rejects.toThrow(/never written/i);
  expect((await vfs.list('default')).items).toEqual([]);
});

test('an upload needing more parts than the plan allows is refused up front', async () => {
  const vfs = await createVfs({ storage: new MemoryStorage(), uploadPartSize: 1024 });
  // 10,000 parts is S3's ceiling, and `#limits()` reported it in the same response that
  // handed back a plan exceeding it — so the upload failed at part 10,001, after the
  // client had already transferred everything before it.
  await expect(vfs.createUpload({ name: 'huge.bin', size: 1024 * 20_000 }))
    .rejects.toThrow(/part limit|over the/i);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A sidecar store with the latency object storage actually has — the race needs a
// window, and `sidecars/<id>.json` lives in the primary backend.
function slowStore(loadMs, saveMs) {
  const docs = new Map();
  return {
    docs,
    store: {
      emptyDoc: sidecarOps.emptyDoc,
      async load(id) { await sleep(loadMs); const d = docs.get(id); return d ? JSON.parse(JSON.stringify(d)) : null; },
      async save(id, doc) { await sleep(saveMs); docs.set(id, JSON.parse(JSON.stringify(doc))); },
    },
  };
}
// Comments are a CRDT map keyed by id, not an array — write them the way the real
// document module does so mergeDoc treats them as it would a real comment.
function addComment(doc, id) {
  doc.clock = (doc.clock || 0) + 1;
  doc.comments[id] = { id, body: id, author: 'tester', at: doc.clock, actor: 'tester' };
}
const ids = (doc) => Object.keys(doc?.comments || {}).sort();
