// Prove the Cloudflare Vectorize adapter shapes correct calls in BOTH access
// modes: the REST API (verified against a mock globalThis.fetch, like the
// Qdrant test) and the Workers binding (verified against a hand-written mock
// binding that records its calls). Both exercise the query-then-delete path
// that stands in for Vectorize's missing delete-by-filter.

import { test, expect } from 'bun:test';
import { VectorizeVectorStore } from '../src/search/vectorize.js';

function jsonRes(obj) {
  return { ok: true, status: 200, json: async () => obj };
}
function cfOk(result) {
  return jsonRes({ success: true, result, errors: [] });
}

test('VectorizeVectorStore (REST) shapes correct calls (mock fetch)', async () => {
  const calls = [];
  let purgeQueries = 0;
  const fetchMock = async (url, opts) => {
    const path = url.replace(/^.*\/indexes\/trove/, '');
    const ndjson = opts.headers['content-type'] === 'application/x-ndjson';
    const body = ndjson ? opts.body : opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, path, method: opts.method, headers: opts.headers, ndjson, body });

    if (path === '/query') {
      // A purge query carries a nodeId filter; return one match, then empty.
      if (body.filter?.nodeId) {
        purgeQueries++;
        if (purgeQueries === 1) {
          return cfOk({ count: 1, matches: [{ id: 'x', score: 1, metadata: { docId: 'x', nodeId: 'n9', indexerId: 'ix' } }] });
        }
        return cfOk({ count: 0, matches: [] });
      }
      // A normal search.
      return cfOk({ matches: [{ id: 'x', score: 0.87, metadata: { docId: 'x', nodeId: 'n9', indexerId: 'ix', name: 'a' } }] });
    }
    return cfOk({});
  };

  const orig = globalThis.fetch;
  globalThis.fetch = fetchMock;
  try {
    const s = new VectorizeVectorStore({ accountId: 'acc', apiKey: 'k', indexName: 'trove', dimensions: 4 });

    // add → NDJSON upsert with the right vector id + metadata.
    const longId = 'chunk:' + 'z'.repeat(80); // > 64 bytes → hashed id, docId kept in metadata
    await s.add([
      { id: 'x', nodeId: 'n9', indexerId: 'ix', vector: [1, 0, 0, 0], fields: { name: 'a', nested: { skip: 1 } } },
      { id: longId, nodeId: 'n9', indexerId: 'ix', vector: [0, 1, 0, 0], fields: {} },
    ]);

    // Metadata indexes created lazily on nodeId + indexerId.
    expect(calls.some((c) => c.path === '/metadata_index/create' && c.body.propertyName === 'nodeId')).toBe(true);
    expect(calls.some((c) => c.path === '/metadata_index/create' && c.body.propertyName === 'indexerId')).toBe(true);

    const upsert = calls.find((c) => c.path === '/upsert');
    expect(upsert.headers['content-type']).toBe('application/x-ndjson');
    expect(upsert.headers.authorization).toBe('Bearer k');
    const lines = upsert.body.split('\n').map((l) => JSON.parse(l));
    expect(lines[0].id).toBe('x');
    expect(lines[0].values).toEqual([1, 0, 0, 0]);
    expect(lines[0].metadata).toEqual({ docId: 'x', nodeId: 'n9', indexerId: 'ix', name: 'a' }); // nested field dropped
    // Long docId → deterministic 64-char SHA-256 hex id, original docId preserved.
    expect(lines[1].id).toMatch(/^[0-9a-f]{64}$/);
    expect(lines[1].metadata.docId).toBe(longId);

    // query → right body + mapped results.
    const res = await s.query([1, 0, 0, 0], { limit: 5, indexers: ['ix'] });
    expect(res[0].nodeId).toBe('n9');
    expect(res[0].score).toBeCloseTo(0.87);
    expect(res[0].fields).toEqual({ name: 'a' }); // reserved keys stripped from fields
    const q = calls.find((c) => c.path === '/query' && !c.body.filter?.nodeId);
    expect(q.body.topK).toBe(20); // min(limit*4, 20)
    expect(q.body.returnMetadata).toBe('all');
    expect(q.body.returnValues).toBe(false);
    expect(q.body.filter).toEqual({ indexerId: { $in: ['ix'] } });

    // removeByNode → query-then-delete_by_ids.
    await s.removeByNode('n9');
    const del = calls.find((c) => c.path === '/delete_by_ids');
    expect(del.body.ids).toEqual(['x']);
    // Looped until an empty query came back (two purge queries issued).
    expect(purgeQueries).toBe(2);
    const purgeQuery = calls.find((c) => c.path === '/query' && c.body.filter?.nodeId);
    expect(purgeQuery.body.filter).toEqual({ nodeId: { $eq: 'n9' } });
    expect(purgeQuery.body.vector).toEqual([0, 0, 0, 0]); // zero vector
  } finally {
    globalThis.fetch = orig;
  }
});

test('VectorizeVectorStore (binding) shapes correct calls (mock binding)', async () => {
  const calls = [];
  let purgeQueries = 0;
  const binding = {
    async upsert(vectors) {
      calls.push(['upsert', vectors]);
    },
    async query(vector, opts) {
      calls.push(['query', vector, opts]);
      if (opts.filter?.nodeId) {
        purgeQueries++;
        if (purgeQueries === 1) return { matches: [{ id: 'x', score: 1, metadata: { docId: 'x', nodeId: 'n9', indexerId: 'ix' } }] };
        return { count: 0, matches: [] };
      }
      return { count: 1, matches: [{ id: 'x', score: 0.91, metadata: { docId: 'x', nodeId: 'n9', indexerId: 'ix', name: 'a' } }] };
    },
    async deleteByIds(ids) {
      calls.push(['deleteByIds', ids]);
    },
    async getByIds(ids) {
      calls.push(['getByIds', ids]);
    },
  };

  const s = new VectorizeVectorStore({ binding, dimensions: 4 });

  // add → upsert with the Vectorize vector shape.
  await s.add([{ id: 'x', nodeId: 'n9', indexerId: 'ix', vector: [1, 0, 0, 0], fields: { name: 'a' } }]);
  const upsert = calls.find((c) => c[0] === 'upsert');
  expect(upsert[1][0].id).toBe('x');
  expect(upsert[1][0].values).toEqual([1, 0, 0, 0]);
  expect(upsert[1][0].metadata).toEqual({ docId: 'x', nodeId: 'n9', indexerId: 'ix', name: 'a' });

  // query → mapped result, defensive over { count, matches } envelope.
  const res = await s.query([1, 0, 0, 0], { limit: 3, indexers: ['ix'] });
  expect(res[0].nodeId).toBe('n9');
  expect(res[0].score).toBeCloseTo(0.91);
  expect(res[0].fields).toEqual({ name: 'a' });
  const q = calls.find((c) => c[0] === 'query' && !c[2].filter?.nodeId);
  expect(q[2].topK).toBe(12); // min(limit*4, 20)
  expect(q[2].returnMetadata).toBe('all');
  expect(q[2].filter).toEqual({ indexerId: { $in: ['ix'] } });

  // removeByNode → query (zero vector + node filter) then deleteByIds, looped.
  await s.removeByNode('n9');
  const del = calls.find((c) => c[0] === 'deleteByIds');
  expect(del[1]).toEqual(['x']);
  expect(purgeQueries).toBe(2);
  const purgeQuery = calls.find((c) => c[0] === 'query' && c[2].filter?.nodeId);
  expect(purgeQuery[1]).toEqual([0, 0, 0, 0]);
  expect(purgeQuery[2].filter).toEqual({ nodeId: { $eq: 'n9' } });

  // remove(docId) → deleteByIds of the mapped id.
  calls.length = 0;
  await s.remove('x');
  expect(calls).toEqual([['deleteByIds', ['x']]]);
});
