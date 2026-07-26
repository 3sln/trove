// The durable search stores. These exist because the in-memory defaults meant a
// restart left every file present and none of it findable — so the thing under test
// here is not really "does it match", it's "is it still there afterwards".
//
// sqlite-vec is an OPTIONAL native dependency. When it can't load, the vector tests
// skip (and `open()` returning null is itself asserted) while the FTS5 keyword tests
// run regardless — FTS5 is compiled into both bun:sqlite and node:sqlite.

import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalSqliteProvider, SqliteVectorStore, SqliteKeywordStore, SearchService,
  MemoryVectorStore, MemoryKeywordStore, LocalHashEmbedding,
} from '../src/index.js';

const DIMS = 8;
const unit = (...v) => {
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
};

// Probe once: everything vector-related hangs off whether the extension loaded.
const hasVec = await (async () => {
  const p = new LocalSqliteProvider({ path: ':memory:' });
  const store = await SqliteVectorStore.open({ provider: p, dimensions: DIMS });
  await p.close();
  return !!store;
})();

async function tempProvider() {
  const dir = await mkdtemp(join(tmpdir(), 'trove-search-'));
  const provider = new LocalSqliteProvider({ path: join(dir, 'trove.db') });
  return {
    provider,
    dir,
    // Close and reopen the same file — the whole point of these stores.
    async restart() {
      await provider.close();
      return new LocalSqliteProvider({ path: join(dir, 'trove.db') });
    },
    async cleanup() { await provider.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('a missing sqlite-vec is a degraded store, not a crash', async () => {
  // `open()` promises null-or-store, never a throw for an absent extension: the caller
  // needs to be able to fall back, and a drive that can't do semantic search should
  // still start and still do keyword search.
  const p = new LocalSqliteProvider({ path: ':memory:' });
  const store = await SqliteVectorStore.open({ provider: p, dimensions: DIMS });
  expect(store === null || store instanceof SqliteVectorStore).toBe(true);
  await p.close();
});

test.if(hasVec)('vectors survive a close and reopen of the database file', async () => {
  const t = await tempProvider();
  try {
    let store = await SqliteVectorStore.open({ provider: t.provider, dimensions: DIMS });
    await store.add([
      { id: 'a', nodeId: 'n1', indexerId: 'ix', vector: unit(1, 0, 0, 0, 0, 0, 0, 0), fields: { name: 'a.md' } },
      { id: 'b', nodeId: 'n2', indexerId: 'other', vector: unit(0, 1, 0, 0, 0, 0, 0, 0) },
    ]);
    expect(await store.count()).toBe(2);

    const reopened = await t.restart();
    store = await SqliteVectorStore.open({ provider: reopened, dimensions: DIMS });
    expect(await store.count()).toBe(2);
    const hits = await store.query(unit(1, 0, 0, 0, 0, 0, 0, 0), { limit: 1 });
    expect(hits[0].nodeId).toBe('n1');
    expect(hits[0].score).toBeGreaterThan(0.99); // L2 distance mapped back to cosine
    expect(hits[0].fields).toEqual({ name: 'a.md' }); // and the sidecar came back too
    await reopened.close();
  } finally {
    await t.cleanup();
  }
});

test.if(hasVec)('an indexer filter still returns a full page of results', async () => {
  // KNN can't be narrowed by a non-vector predicate, so the store over-fetches and
  // filters. Without that, asking for 3 and getting 1 (because the nearest neighbours
  // belonged to another indexer) would look like an empty drive.
  const p = new LocalSqliteProvider({ path: ':memory:' });
  const store = await SqliteVectorStore.open({ provider: p, dimensions: DIMS });
  const docs = [];
  for (let i = 0; i < 30; i++) {
    // Interleave: the nearest 10 are mostly 'noise'.
    docs.push({ id: `d${i}`, nodeId: `n${i}`, indexerId: i % 3 === 0 ? 'wanted' : 'noise', vector: unit(1, i / 100, 0, 0, 0, 0, 0, 0) });
  }
  await store.add(docs);
  const hits = await store.query(unit(1, 0, 0, 0, 0, 0, 0, 0), { limit: 3, indexers: ['wanted'] });
  expect(hits.length).toBe(3);
  expect(hits.every((h) => h.indexerId === 'wanted')).toBe(true);
  await p.close();
});

test.if(hasVec)('removes take the vector and its sidecar row together', async () => {
  const p = new LocalSqliteProvider({ path: ':memory:' });
  const store = await SqliteVectorStore.open({ provider: p, dimensions: DIMS });
  await store.add([
    { id: 'a', nodeId: 'n1', indexerId: 'ix', vector: unit(1, 0, 0, 0, 0, 0, 0, 0) },
    { id: 'b', nodeId: 'n1', indexerId: 'other', vector: unit(0, 1, 0, 0, 0, 0, 0, 0) },
    { id: 'c', nodeId: 'n2', indexerId: 'ix', vector: unit(0, 0, 1, 0, 0, 0, 0, 0) },
  ]);
  await store.removeByNodeIndexer('n1', 'ix');
  expect(await store.count()).toBe(2);
  // A dangling vec0 row would still come back from a query even with its sidecar gone.
  expect((await store.query(unit(1, 0, 0, 0, 0, 0, 0, 0), { limit: 10 })).some((h) => h.docId === 'a')).toBe(false);
  await store.removeByNode('n1');
  expect(await store.count()).toBe(1);
  await store.removeByIndexer('ix');
  expect(await store.count()).toBe(0);
  await p.close();
});

test.if(hasVec)('changing the embedding dimensions drops the index instead of wedging it', async () => {
  // A vec0 table's width is fixed at CREATE time. Reopening at a new width has to drop
  // the vectors — the alternative is every insert failing forever, which reads as a
  // broken drive rather than an unindexed one. Dropping leaves it empty, which is the
  // state the server's startup rebuild watches for.
  const t = await tempProvider();
  try {
    let store = await SqliteVectorStore.open({ provider: t.provider, dimensions: DIMS });
    await store.add([{ id: 'a', nodeId: 'n1', indexerId: 'ix', vector: unit(1, 0, 0, 0, 0, 0, 0, 0) }]);
    expect(await store.count()).toBe(1);

    const reopened = await t.restart();
    store = await SqliteVectorStore.open({ provider: reopened, dimensions: DIMS * 2 });
    expect(await store.count()).toBe(0);
    // …and it is usable at the new width, not just empty.
    await store.add([{ id: 'a', nodeId: 'n1', indexerId: 'ix', vector: new Array(DIMS * 2).fill(0).map((_, i) => (i === 0 ? 1 : 0)) }]);
    expect(await store.count()).toBe(1);
    await reopened.close();
  } finally {
    await t.cleanup();
  }
});

test('keyword documents survive a close and reopen of the database file', async () => {
  const t = await tempProvider();
  try {
    let store = await SqliteKeywordStore.open({ provider: t.provider });
    await store.add([
      { id: 'k1', nodeId: 'n1', indexerId: 'ix', text: 'The spice melange extends life.', fields: { name: 'dune.md' } },
      { id: 'k2', nodeId: 'n2', indexerId: 'ix', text: 'Sandworms are drawn to rhythmic vibration.', fields: { name: 'worms.md' } },
    ]);

    const reopened = await t.restart();
    store = await SqliteKeywordStore.open({ provider: reopened });
    expect(await store.count()).toBe(2);
    const hits = await store.search('melange');
    expect(hits.map((h) => h.nodeId)).toEqual(['n1']);
    expect(hits[0].fields).toEqual({ name: 'dune.md' });
    // A match is worth something even on a corpus small enough that BM25's IDF is 0 —
    // otherwise keyword search contributes nothing to the blend on a new drive.
    expect(hits[0].score).toBeGreaterThanOrEqual(0.5);
    // Field values are indexed, so searching a filename finds the chunk…
    expect((await store.search('dune')).map((h) => h.nodeId)).toEqual(['n1']);
    // …but the snippet is the document's prose, not prose with metadata glued on.
    expect(await store.snippet('k1', 'melange')).not.toMatch(/dune\.md/);
    expect(await store.snippet('k1', 'melange')).toMatch(/spice melange/);
    await reopened.close();
  } finally {
    await t.cleanup();
  }
});

test('a hostile query is no results, not a SQL error', async () => {
  // FTS5's MATCH grammar is full of operators. Raw user input reaching it would turn a
  // stray quote into a failed search — a 500 where the honest answer is "no matches".
  const p = new LocalSqliteProvider({ path: ':memory:' });
  const store = await SqliteKeywordStore.open({ provider: p });
  await store.add([{ id: 'k1', nodeId: 'n1', indexerId: 'ix', text: 'ordinary words here', fields: {} }]);
  for (const q of ['"NEAR( OR ^*', '"', 'a AND (', '***', 'OR OR OR', '']) {
    expect(await store.search(q)).toEqual([]);
  }
  // And a query that mixes syntax with a real term still finds it, literally.
  expect((await store.search('"ordinary*')).map((h) => h.nodeId)).toEqual(['n1']);
  await p.close();
});

test('keyword removes are scoped the same way the memory store scopes them', async () => {
  const p = new LocalSqliteProvider({ path: ':memory:' });
  const store = await SqliteKeywordStore.open({ provider: p });
  await store.add([
    { id: 'k1', nodeId: 'n1', indexerId: 'ix', text: 'alpha beta', fields: {} },
    { id: 'k2', nodeId: 'n1', indexerId: 'other', text: 'alpha gamma', fields: {} },
    { id: 'k3', nodeId: 'n2', indexerId: 'ix', text: 'alpha delta', fields: {} },
  ]);
  await store.removeByNodeIndexer('n1', 'ix');
  expect(await store.count()).toBe(2);
  await store.removeByNode('n1');
  expect(await store.count()).toBe(1);
  await store.removeByIndexer('ix');
  expect(await store.count()).toBe(0);
  // Re-adding the same doc id replaces rather than duplicates.
  const doc = { id: 'k1', nodeId: 'n1', indexerId: 'ix', text: 'alpha beta', fields: {} };
  await store.add([doc]);
  await store.add([doc]);
  expect(await store.count()).toBe(1);
  await p.close();
});

test('looksUnindexed answers only when the stores can actually count', async () => {
  const embeddings = new LocalHashEmbedding({ dimensions: 16 });
  const empty = new SearchService({ embeddings, vectorStore: new MemoryVectorStore({ dimensions: 16 }), keywordStore: new MemoryKeywordStore() });
  expect(await empty.looksUnindexed()).toBe(true);
  await empty.indexName({ id: 'n1', name: 'a.md', collectionId: 'default' });
  await empty.indexDocuments('n1', 'ix', [{ text: 'hello' }]);
  expect(await empty.looksUnindexed()).toBe(false);

  // Half an index is still a broken one: vectors present, keywords lost.
  const half = new SearchService({ embeddings, vectorStore: empty.vectors, keywordStore: new MemoryKeywordStore() });
  expect(await half.looksUnindexed()).toBe(true);

  // A store that can't report a count is never taken as evidence of emptiness — a
  // false positive here would re-read every file in the drive on every start.
  class Mute extends MemoryVectorStore { async count() { return null; } }
  const mute = new SearchService({ embeddings, vectorStore: new Mute({ dimensions: 16 }), keywordStore: { async count() { return null; } } });
  expect(await mute.looksUnindexed()).toBe(null);
});

test('re-indexing cost does not grow with the size of the index', async () => {
  // This is a shape test, not a speed test — it asserts an algorithm, not a machine.
  //
  // FTS5 can only be searched by its term index, so a predicate on an UNINDEXED column
  // is a full scan. Every write re-indexes a node, which deletes its old rows first, so
  // without a rowid sidecar each upload scanned the whole index and the drive got
  // slower the more it held: uploading 2,000 files took 14s for the first 500 and 40s
  // for the last 500. That is the regression this pins.
  const p = new LocalSqliteProvider({ path: ':memory:' });
  const store = await SqliteKeywordStore.open({ provider: p });

  const fill = async (upTo) => {
    for (let i = await store.count(); i < upTo; i++) {
      await store.add([{ id: `d${i}`, nodeId: `n${i}`, indexerId: 'ix', text: `document number ${i} about sailing`, fields: {} }]);
    }
  };
  // Average over several writes so one outlier can't decide the result.
  const costPerWrite = async (label) => {
    const start = performance.now();
    for (let k = 0; k < 40; k++) {
      await store.add([{ id: `probe_${label}_${k}`, nodeId: `p${k}`, indexerId: 'ix', text: 'probe document', fields: {} }]);
    }
    return (performance.now() - start) / 40;
  };

  await fill(500);
  const small = await costPerWrite('small');
  await fill(6000);
  const large = await costPerWrite('large');

  // 12× the index. Linear behaviour would show up as roughly 12× the cost; a generous
  // 4× ceiling catches that while leaving room for cache effects and a noisy CI box.
  expect(large).toBeLessThan(small * 4 + 1);
  await p.close();
});

test('a snippet is fetched by rowid, not by scanning the index', async () => {
  // Same failure in the read path: one snippet per result row meant a page of results
  // did forty full scans, and search slowed from 27ms to 685ms as the drive grew.
  const p = new LocalSqliteProvider({ path: ':memory:' });
  const store = await SqliteKeywordStore.open({ provider: p });
  for (let i = 0; i < 3000; i++) {
    await store.add([{ id: `d${i}`, nodeId: `n${i}`, indexerId: 'ix', text: `filler document ${i}`, fields: {} }]);
  }
  await store.add([{ id: 'target', nodeId: 'nt', indexerId: 'ix', text: 'the spice melange extends life', fields: {} }]);

  const start = performance.now();
  for (let k = 0; k < 40; k++) await store.snippet('target', 'melange');
  const perSnippet = (performance.now() - start) / 40;
  expect(await store.snippet('target', 'melange')).toMatch(/melange/);
  // A full scan of 3,000 FTS rows is milliseconds; a rowid lookup is microseconds.
  expect(perSnippet).toBeLessThan(1);
  // A snippet for something that isn't there is null, not a throw.
  expect(await store.snippet('no-such-doc', 'melange')).toBe(null);
  await p.close();
});

test('an index written before the sidecar existed is adopted, not leaked', async () => {
  // Upgrading a real drive: rows inserted by the previous version have no sidecar entry,
  // so nothing could ever delete them — a re-index would double-count every document.
  const t = await tempProvider();
  try {
    let store = await SqliteKeywordStore.open({ provider: t.provider });
    // Simulate the old shape: a row in the FTS table with no kw_meta entry.
    await store.db.run(
      "INSERT INTO kw_docs(content, body, doc_id, nodeId, indexerId, fields) VALUES ('legacy text','legacy text','old1','nOld','ix','{}')",
    );
    await store.db.run("DELETE FROM kw_meta WHERE doc_id = 'old1'");

    const reopened = await t.restart();
    store = await SqliteKeywordStore.open({ provider: reopened });
    // Adopted on open, so it is now deletable like anything else.
    await store.removeByNode('nOld');
    expect(await store.count()).toBe(0);
    await reopened.close();
  } finally {
    await t.cleanup();
  }
});

test('two processes can share one index without breaking it', async () => {
  // SQLite in WAL mode genuinely supports several processes, so someone WILL point two
  // Trove instances at one data directory. An in-process rowid counter made both start
  // at 1 and every insert fail on the primary key — indexing broken outright for the
  // second one. There is no coordination between processes to have, so the database
  // allocates rowids and we read them back.
  const t = await tempProvider();
  try {
    const second = new LocalSqliteProvider({ path: join(t.dir, 'trove.db') });
    const a = await SqliteKeywordStore.open({ provider: t.provider });
    const b = await SqliteKeywordStore.open({ provider: second });

    await a.add([{ id: 'a1', nodeId: 'n1', indexerId: 'ix', text: 'alpha from A', fields: {} }]);
    await b.add([{ id: 'b1', nodeId: 'n2', indexerId: 'ix', text: 'beta from B', fields: {} }]);
    await a.add([{ id: 'a2', nodeId: 'n3', indexerId: 'ix', text: 'gamma from A', fields: {} }]);
    expect(await a.count()).toBe(3);
    expect((await b.search('alpha')).length).toBe(1); // each sees the other's writes
    expect((await a.search('beta')).length).toBe(1);

    // Re-indexing the same document from the other process replaces rather than duplicates.
    await a.add([{ id: 'shared', nodeId: 'ns', indexerId: 'ix', text: 'first version', fields: {} }]);
    await b.add([{ id: 'shared', nodeId: 'ns', indexerId: 'ix', text: 'second version', fields: {} }]);
    expect(await a.count()).toBe(4);
    // …and a delete from one is honoured by the other.
    await b.removeByNode('n1');
    expect((await a.search('alpha')).length).toBe(0);
    expect(await a.count()).toBe(3);
    await second.close();
  } finally {
    await t.cleanup();
  }
});
