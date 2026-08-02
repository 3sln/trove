// The failures that lose data quietly.
//
// Everything here is a case where the system already told the user it succeeded — the
// comment is on screen, the file is deleted, the upload was cancelled — and the only way
// to notice it lied is to come back later and find something missing, or an invoice for
// storage nobody can reach. Each of these was real.

import { test, expect } from 'bun:test';
import {
  createVfs, MemoryStorage, SidecarManager, SidecarService, IssueRegistry, MemoryKV,
  UploadManager, StorageBackend,
} from '../src/index.js';

// --- sidecar: an acknowledged comment must not be discardable ------------------

/** A sidecar store whose writes can be made to fail on demand. */
function flakyStore() {
  const docs = new Map();
  return {
    broken: false,
    async load(id) { return docs.get(id) || null; },
    async save(id, doc) {
      if (this.broken) throw new Error('storage is having a moment');
      docs.set(id, doc);
    },
    emptyDoc: (id) => ({ nodeId: id, comments: {}, tags: {} }),
    _docs: docs,
  };
}

test('a comment that could not be saved is kept, not swept away', async () => {
  // The API replied 200 and the comment is on screen. Between that and a successful
  // flush, memory holds the ONLY copy — so evicting on idle "because we tried" turns a
  // storage blip into a comment that vanishes a minute later.
  const store = flakyStore();
  const m = new SidecarManager({ store, flushDelayMs: 5, idleEvictMs: 0 });
  await m.mutate('n1', (doc) => { doc.comments.c1 = { body: 'hello' }; });
  store.broken = true;

  await m.sweep();
  expect(m.hot.has('n1')).toBe(true); // still here
  expect((await m.get('n1')).comments.c1.body).toBe('hello');

  // And once storage comes back, the comment lands.
  store.broken = false;
  await m.retryPending();
  expect(store._docs.get('n1').comments.c1.body).toBe('hello');
  // idleEvictMs is 0 here, so let the clock move past the last access before sweeping.
  await new Promise((r) => setTimeout(r, 5));
  await m.sweep();
  expect(m.hot.has('n1')).toBe(false); // clean, so now it may go
});

test('a write-back that keeps failing becomes a standing problem', async () => {
  // A console line scrolls away. The person who wrote the comment has been told it
  // saved, so the drive owes them a visible "actually, it didn't".
  const issues = new IssueRegistry({ kv: new MemoryKV() });
  const store = flakyStore();
  store.broken = true;
  const m = new SidecarManager({ store, flushDelayMs: 1, idleEvictMs: 0, issues, maxFlushRetries: 0 });
  await m.mutate('n1', (doc) => { doc.comments.c1 = { body: 'hello' }; });

  await new Promise((r) => setTimeout(r, 60));
  const raised = await issues.list();
  expect(raised.some((i) => i.kind === 'sidecar-flush')).toBe(true);
  // `{ op, nodeId }`, and the assertion has to read `.op`. It pinned the bare string for a
  // long time, which meant two pieces of evidence — this and the comment above the raise —
  // said a Retry worked when `canRetry` reads `issue.retry.op` and answered false.
  const flush = raised.find((i) => i.kind === 'sidecar-flush');
  expect(flush.retry.op).toBe('sidecar-flush');
  expect(flush.retry.nodeId).toBe('n1');
  // And it is only reported retryable once something is registered to do it.
  expect(issues.canRetry(flush)).toBe(false);
  issues.handle('sidecar-flush', () => m.retryPending());
  expect(issues.canRetry(flush)).toBe(true);
});

test('an issue whose retry is not { op } is refused at the raise', async () => {
  // A bare string is silently un-retryable: `canRetry` reads `issue.retry.op`, so the
  // button never renders and nothing says why. Caught where the mistake is made.
  const issues = new IssueRegistry({ kv: new MemoryKV() });
  await expect(issues.raise({ kind: 'x', title: 'y', retry: 'do-it' })).rejects.toThrow(/must be \{ op \}/);
  await expect(issues.raise({ kind: 'x', title: 'y', retry: { nodeId: 'n1' } })).rejects.toThrow(/must be \{ op \}/);
  // Absent is fine — most issues are not retryable.
  expect((await issues.raise({ kind: 'x', title: 'y' })).retry).toBe(null);
});

test('shutdown reports what it could not save instead of exiting quietly', async () => {
  // Exiting 0 after dropping someone's comments is a lie the process tells on its way out.
  const store = flakyStore();
  const m = new SidecarManager({ store, flushDelayMs: 5, idleEvictMs: 60_000 });
  await m.mutate('n1', (doc) => { doc.comments.c1 = { body: 'hi' }; });
  store.broken = true;
  const result = await m.dispose();
  expect(result.failed).toHaveLength(1);
  expect(result.failed[0].nodeId).toBe('n1');
});

// --- delete: never leave a record pointing at bytes that are gone --------------

test('a failed index removal does not destroy the file anyway', async () => {
  // Order matters, and it is the opposite of the obvious one. An orphan blob is wasted
  // space nobody sees; a record whose bytes are gone is an item that lists, opens, and
  // 404s forever.
  const issues = new IssueRegistry({ kv: new MemoryKV() });
  const vfs = await createVfs({ storage: new MemoryStorage(), issues });
  const node = await vfs.writeFile('doomed.txt', 'bytes', { contentType: 'text/plain' });

  vfs.search.removeNode = async () => { throw new Error('index is down'); };
  const res = await vfs.remove(node.id, { permanent: true });
  expect(res.ok).toBe(true);

  // The record is gone — the delete the user asked for actually happened.
  expect(await vfs.find('doomed.txt')).toBeFalsy();
  // And the failure was recorded rather than swallowed.
  expect((await issues.list()).some((i) => i.kind === 'search-cleanup')).toBe(true);
});

test('a trashed item never comes back in search results', async () => {
  // Deleting removes it from the index — but that removal can fail, and then the user
  // clicks a result for a file they deliberately deleted and gets a 404.
  const vfs = await createVfs({ storage: new MemoryStorage() });
  const node = await vfs.writeFile('secret-plans.txt', 'a memorable unique phrase', { contentType: 'text/plain' });
  expect((await vfs.searchQuery('memorable')).length).toBeGreaterThan(0);

  // Trash it, but make the index removal fail so the entry is left behind.
  vfs.search.removeNode = async () => { throw new Error('index is down'); };
  await vfs.remove(node.id);

  const hits = await vfs.searchQuery('memorable');
  expect(hits.map((h) => h.node.name)).not.toContain('secret-plans.txt');
});

// --- re-index: stale content must not stay searchable -------------------------

test('emptying a file removes its old text from the index', async () => {
  // indexDocuments clears prior docs before writing, so [] is how you say "nothing here
  // now". Skipping the call when the list was empty left the old chunks forever: search
  // kept returning the file, with a snippet of text no longer in it.
  const vfs = await createVfs({ storage: new MemoryStorage() });
  await vfs.writeFile('notes.txt', 'the pelican brief was here', { contentType: 'text/plain' });
  expect((await vfs.searchQuery('pelican')).length).toBeGreaterThan(0);

  await vfs.writeFile('notes.txt', '   ', { contentType: 'text/plain' });
  const hits = await vfs.searchQuery('pelican');
  expect(hits.map((h) => h.node.name)).not.toContain('notes.txt');
});

// --- uploads: an abandoned upload must release its parts ----------------------

test('sweeping an abandoned upload aborts it instead of orphaning the parts', async () => {
  // The session record holds the S3 uploadId, and that is the ONLY handle that can abort
  // the multipart. Deleting the record on expiry left the parts stored and billed with
  // nothing that could ever reclaim them.
  const aborted = [];
  class Recording extends MemoryStorage {
    get capabilities() { return { ...super.capabilities, multipart: true, presignUpload: true }; }
    async createMultipart(key) { return 'mp-1'; }
    async abortMultipart(key, uploadId) { aborted.push({ key, uploadId }); }
    async presignPart() { return 'https://example.test/part'; }
  }
  const storage = new Recording();
  const uploads = new UploadManager({ storage });
  const created = await uploads.create({ name: 'huge.bin', size: 200 * 1024 * 1024, contentType: 'application/octet-stream' });
  expect(await uploads.sessions.get(created.uploadId)).toBeTruthy();

  // Far enough in the future that the session has expired.
  const result = await uploads.sweepExpired(Date.now() + 30 * 24 * 3600_000);
  expect(result.aborted).toBe(1);
  expect(aborted).toHaveLength(1);         // the backend was actually told
  expect(aborted[0].uploadId).toBe('mp-1');
  expect(await uploads.sessions.get(created.uploadId)).toBe(null);
});

test('a live upload is left alone by the sweep', async () => {
  const uploads = new UploadManager({ storage: new MemoryStorage() });
  const created = await uploads.create({ name: 'small.txt', size: 10, contentType: 'text/plain' });
  const result = await uploads.sweepExpired(Date.now());
  expect(result.aborted).toBe(0);
  expect(await uploads.sessions.get(created.uploadId)).toBeTruthy();
});
