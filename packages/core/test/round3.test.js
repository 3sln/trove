// The round-3 findings that were deferred and then fixed. Mostly "confidently wrong
// answer" territory: nothing threw, the numbers were just not the numbers.

import { test, expect } from 'bun:test';
import {
  createVfs, MemoryStorage, MemoryStore, MemoryVectorStore, SearchService,
  LocalHashEmbedding, PrefixedStorage, withRetry,
} from '../src/index.js';

// --- paging and the scanner ----------------------------------------------------

test('mixed-case names survive paging, so a scan does not duplicate them', async () => {
  const store = new MemoryStore();
  await store.init();
  // The store sorted with raw `<` (code-unit, case-SENSITIVE) while the cursor compared
  // case-insensitively, so these four straddled the page boundary in two different
  // orders and two of them were returned by no page at all.
  for (const name of ['apple.txt', 'Banana.txt', 'cherry.txt', 'Date.txt']) {
    await store.create({ name, collectionId: 'default' });
  }
  const seen = [];
  let cursor = null;
  do {
    const page = await store.listItems('default', { limit: 1, cursor });
    seen.push(...page.items.map((i) => i.name));
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen.sort()).toEqual(['Banana.txt', 'Date.txt', 'apple.txt', 'cherry.txt'].sort());
  expect(seen.length).toBe(await store.countItems('default'));
});

// --- search ---------------------------------------------------------------------

test('a tag filter narrows a text search instead of emptying it', async () => {
  const vfs = await createVfs({ storage: new MemoryStorage() });
  // Enough matching files that the tagged one falls outside the first page of results.
  for (let i = 0; i < 60; i++) {
    await vfs.writeFile(`sailing-${i}.txt`, 'trimming the mainsail while sailing', { contentType: 'text/plain' });
  }
  const target = await vfs.writeFile('sailing-draft.txt', 'trimming the mainsail while sailing', { contentType: 'text/plain' });
  await vfs.metadata.setContribution(target.id, 'trove+contrib:t.example/t/idx', { tags: { draft: true } });

  // `#draft` alone found it; `sailing #draft` did not, because the tag filter ran
  // OUTSIDE searchQuery's widening loop, on an already-truncated page. It is one of
  // the examples the transformer itself advertises.
  const both = await vfs.query('sailing #draft', { limit: 10 });
  expect(both.results.map((r) => r.node.name)).toContain('sailing-draft.txt');
});

test('matching in more places never lowers a score', async () => {
  // The score was REPLACED by whichever hit was larger, DISCARDING everything already
  // accumulated — so folding in another matching chunk could lower a node's total, and
  // the reported `fields` came from a chunk other than the reported `docId`.
  const embeddings = new LocalHashEmbedding({ dimensions: 64 });
  const search = new SearchService({ embeddings, vectorStore: new MemoryVectorStore({ dimensions: 64 }) });
  const text = 'sourdough bread baking';
  await search.indexDocuments('once', 'ix', [{ text }]);
  await search.indexDocuments('twice', 'ix', [{ text }, { text }]);

  const hits = await search.search('sourdough bread', { limit: 5 });
  const score = (id) => hits.find((h) => h.nodeId === id)?.score ?? 0;
  expect(score('twice')).toBeGreaterThan(score('once'));
  expect(hits[0].nodeId).toBe('twice');
});

test('a failed embedding leaves the previous index in place', async () => {
  const embeddings = new LocalHashEmbedding({ dimensions: 64 });
  const search = new SearchService({ embeddings, vectorStore: new MemoryVectorStore({ dimensions: 64 }) });
  await search.indexDocuments('n', 'ix', [{ text: 'a findable sentence' }]);
  expect((await search.search('findable', { limit: 5 })).length).toBe(1);

  // Both removals used to run BEFORE embedding, so a transient outage during a
  // re-index left the file with nothing at all — recoverable through the issue, but
  // unfindable in the meantime, and the old index had been perfectly good.
  const boom = new Error('embedding service unavailable');
  search.embeddings = { embed: async () => { throw boom; }, embedOne: (t) => embeddings.embedOne(t) };
  await expect(search.indexDocuments('n', 'ix', [{ text: 'a replacement sentence' }])).rejects.toThrow(boom);
  search.embeddings = embeddings;
  expect((await search.search('findable', { limit: 5 })).length).toBe(1);
});

// --- ranges ---------------------------------------------------------------------

test('an unsatisfiable range is 416, not 400 or 500', async () => {
  const storage = new MemoryStorage();
  await storage.put('k', new TextEncoder().encode('abc'));
  await expect(storage.get('k', { range: { start: 10, end: 20 } })).rejects.toMatchObject({ status: 416 });
  // `bytes=-0` asks for the last zero bytes. S3 answers it with the WHOLE object under
  // a 200, so it has to be caught before the backend sees it.
  await expect(storage.get('k', { range: { suffix: 0 } })).rejects.toMatchObject({ status: 416 });
});

// --- leaks ----------------------------------------------------------------------

test('a retried operation does not leak an abort listener per attempt', async () => {
  const ac = new AbortController();
  let listeners = 0;
  const signal = ac.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...a) => { listeners++; return add(...a); };
  signal.removeEventListener = (...a) => { listeners--; return remove(...a); };

  let n = 0;
  // `{ once: true }` removes a listener when it FIRES — not when the timer wins, which
  // is every normal retry. One long-lived signal accumulated one per attempt.
  await withRetry(async () => {
    if (++n < 4) { const e = new Error('flaky'); e.code = 'ECONNRESET'; throw e; }
    return 'ok';
  }, { signal, minDelayMs: 1, jitter: false });
  expect(n).toBe(4);
  expect(listeners).toBe(0);
});

test('the in-memory vector index shrinks when documents are removed', async () => {
  const store = new MemoryVectorStore({ dimensions: 4 });
  await store.add([
    { id: 'a', nodeId: 'n1', indexerId: 'ix', vector: [1, 0, 0, 0], fields: {} },
    { id: 'b', nodeId: 'n2', indexerId: 'ix', vector: [0, 1, 0, 0], fields: {} },
  ]);
  // Removing by node dropped the docs and its own index entry but left their ids in
  // the SIBLING index forever — correct answers, unbounded memory.
  await store.removeByNode('n1');
  expect(store.byIndexer.get('ix')?.size ?? 0).toBe(1);
  await store.removeByNode('n2');
  expect(store.byIndexer.size).toBe(0);
  expect(await store.count()).toBe(0);
});

// --- uploads --------------------------------------------------------------------

test('a part number outside the plan is refused, including NaN', async () => {
  const vfs = await createVfs({ storage: new MemoryStorage(), uploadPartSize: 3 });
  const plan = await vfs.createUpload({ name: 'x.bin', size: 6 });
  expect(plan.partCount).toBe(2);
  // `NaN < 1` and `NaN > partCount` are both false, so this walked through and wrote
  // bytes under the key "NaN" — billed, and unmergeable.
  await expect(vfs.uploadPart(plan.uploadId, Number('nope'), new Uint8Array([1]))).rejects.toThrow(/outside/i);
  await expect(vfs.uploadPart(plan.uploadId, 99, new Uint8Array([1]))).rejects.toThrow(/outside/i);
  // reportPart had no bounds check at all.
  await expect(vfs.uploads.reportPart(plan.uploadId, 5000, 'etag')).rejects.toThrow(/outside/i);
});

test('a refused upload plan leaves no multipart open behind it', async () => {
  let opened = 0;
  let aborted = 0;
  class Counting extends MemoryStorage {
    async createMultipart(...a) { opened++; return super.createMultipart(...a); }
    async abortMultipart(...a) { aborted++; return super.abortMultipart(...a); }
  }
  const vfs = await createVfs({ storage: new Counting(), uploadPartSize: 1024 });
  // Over the 10,000-part ceiling. The multipart used to be opened first, so the refusal
  // left an upload in the bucket with no session record — nothing could ever abort it.
  await expect(vfs.createUpload({ name: 'huge.bin', size: 1024 * 20_000 })).rejects.toThrow(/part limit|over the/i);
  expect(opened).toBe(0);
  expect(aborted).toBe(0);
});

test('an abort that the backend refuses does not discard the session', async () => {
  class Stubborn extends MemoryStorage {
    async abortMultipart() { throw new Error('S3 said no'); }
  }
  const vfs = await createVfs({ storage: new Stubborn(), uploadPartSize: 3 });
  const plan = await vfs.createUpload({ name: 'x.bin', size: 6 });
  // Swallowing the failure and deleting the record anyway is how the staged parts became
  // unreclaimable — the session holds the only uploadId that could ever abort them.
  await expect(vfs.abortUpload(plan.uploadId)).rejects.toThrow(/S3 said no/);
  expect(await vfs.uploadStatus(plan.uploadId)).toBeTruthy();
});

// --- who is an admin ------------------------------------------------------------

test('an admin can be named by email, not only by the IdP\'s internal id', async () => {
  const { CollectionService, MemoryKV, MemoryStorage: MS } = await import('../src/index.js');
  const svc = (admins) => new CollectionService({ kv: new MemoryKV(), storageFactory: () => new MS(), admins });
  // Cloudflare Access puts an internal user UUID in `sub`, so that is `principal.id`;
  // the address the operator thinks of as the user is a separate claim. Matching only
  // on id meant `TROVE_ADMINS=you@example.com` silently granted nothing, with no way to
  // find the UUID short of decoding a JWT — a drive that looks administered and isn't.
  const principal = { id: '8f2a1c04-6d3e-4b18-9a77-0c5e2b1d9f30', email: 'Ray@Example.com', roles: [] };
  const byEmail = svc(['ray@example.com']);
  const byId = svc([principal.id]);
  const neither = svc(['someone@else.com']);

  expect(byEmail.isAdmin(principal)).toBe(true); // and case-insensitively
  expect(byId.isAdmin(principal)).toBe(true);
  expect(neither.isAdmin(principal)).toBe(false);
  expect(neither.isAdmin(null)).toBe(false);
});

test('a collection shared with a user by email reaches them', async () => {
  const { CollectionService, MemoryKV, MemoryStorage: MS } = await import('../src/index.js');
  const svc = new CollectionService({ kv: new MemoryKV(), storageFactory: () => new MS(), admins: ['boss@example.com'] });
  await svc.init();
  const c = await svc.create(
    { name: 'Team', store: { driver: 'memory' }, acl: { grants: [{ type: 'user', subject: 'ray@example.com', capabilities: ['read'] }] } },
    { id: 'boss-uuid', email: 'boss@example.com', roles: [] },
  );
  const record = await svc.get(c.id);
  // An ACL a human wrote names people the way humans do.
  expect(svc.can({ id: 'ray-uuid', email: 'ray@example.com', roles: [] }, record, 'read')).toBe(true);
  expect(svc.can({ id: 'other-uuid', email: 'other@example.com', roles: [] }, record, 'read')).toBe(false);
  expect(c.id).toStartWith('col_');
});
