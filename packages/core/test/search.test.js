// Prove the search layer is genuinely pluggable: the in-memory stores implement
// the async contract, an injected custom VectorStore is used by SearchService,
// and the Qdrant adapter shapes real REST calls (verified against a mock fetch).

import { test, expect } from 'bun:test';
import {
  SearchService, VectorStore, MemoryVectorStore, MemoryKeywordStore,
  QdrantVectorStore, LocalHashEmbedding,
} from '../src/index.js';

test('MemoryVectorStore: async add/query/remove by node & indexer', async () => {
  const s = new MemoryVectorStore({ dimensions: 3 });
  await s.add([
    { id: 'a', nodeId: 'n1', indexerId: 'ix', vector: [1, 0, 0] },
    { id: 'b', nodeId: 'n2', indexerId: 'ix', vector: [0, 1, 0] },
  ]);
  expect(await s.count()).toBe(2);
  const hits = await s.query([1, 0, 0], { limit: 1 });
  expect(hits[0].nodeId).toBe('n1');
  await s.removeByNode('n1');
  expect(await s.count()).toBe(1);
  await s.removeByIndexer('ix');
  expect(await s.count()).toBe(0);
});

test('SearchService uses an INJECTED custom VectorStore', async () => {
  // A minimal external-store stand-in that records that it was used.
  const calls = { add: 0, query: 0 };
  class FakeStore extends VectorStore {
    constructor() { super(); this._dimensions = 0; this.docs = []; }
    async add(docs) { calls.add++; this.docs.push(...docs); }
    async removeByNodeIndexer() {}
    async removeByNode() {}
    async removeByIndexer() {}
    async query() { calls.query++; return this.docs.map((d) => ({ docId: d.id, nodeId: d.nodeId, indexerId: d.indexerId, score: 0.9, fields: d.fields })); }
  }
  const store = new FakeStore();
  const search = new SearchService({ embeddings: new LocalHashEmbedding({ dimensions: 32 }), vectorStore: store });
  expect(search.vectors).toBe(store); // the injected instance, not a default

  await search.indexDocuments('n1', 'plugin.x', [{ text: 'orbital mechanics and rocketry' }]);
  expect(calls.add).toBe(1);
  const results = await search.search('space flight', { mode: 'semantic' });
  expect(calls.query).toBe(1);
  expect(results[0].nodeId).toBe('n1');
});

test('MemoryKeywordStore search + snippet', async () => {
  const k = new MemoryKeywordStore();
  await k.add([{ id: 'd1', nodeId: 'n1', indexerId: 'core.text', text: 'The migration of arctic terns spans pole to pole.', fields: {} }]);
  const hits = await k.search('arctic migration');
  expect(hits[0].nodeId).toBe('n1');
  const snip = await k.snippet('d1', 'arctic');
  expect(snip).toContain('arctic');
});

test('QdrantVectorStore shapes correct REST calls (mock fetch)', async () => {
  const calls = [];
  const fetchMock = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    if (url.endsWith('/exists')) return jsonRes({ result: { exists: false } });
    if (url.endsWith('/points/search')) {
      return jsonRes({ result: [{ score: 0.87, payload: { docId: 'x', nodeId: 'n9', indexerId: 'ix', fields: { name: 'a' } } }] });
    }
    return jsonRes({ result: true, status: 'ok' });
  };
  const orig = globalThis.fetch;
  globalThis.fetch = fetchMock;
  try {
    const s = new QdrantVectorStore({ url: 'http://q:6333', collection: 'trove', dimensions: 4, apiKey: 'k' });
    await s.add([{ id: 'x', nodeId: 'n9', indexerId: 'ix', vector: [1, 0, 0, 0], fields: { name: 'a' } }]);
    const res = await s.query([1, 0, 0, 0], { limit: 5, indexers: ['ix'] });
    expect(res[0].nodeId).toBe('n9');
    expect(res[0].score).toBeCloseTo(0.87);

    // Collection auto-created, points upserted, search filtered by indexer.
    expect(calls.some((c) => c.method === 'PUT' && /\/collections\/trove$/.test(c.url))).toBe(true);
    const upsert = calls.find((c) => /\/points\?wait=true/.test(c.url));
    expect(upsert.body.points[0].payload.docId).toBe('x');
    expect(typeof upsert.body.points[0].id).toBe('string'); // deterministic uuid
    const searchCall = calls.find((c) => c.url.endsWith('/points/search'));
    expect(searchCall.body.filter.must[0].match.any).toEqual(['ix']);
  } finally {
    globalThis.fetch = orig;
  }
});

function jsonRes(obj) {
  return { ok: true, status: 200, json: async () => obj };
}
