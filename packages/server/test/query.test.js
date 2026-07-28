// The unified /api/query endpoint: the search transformer resolves a raw string
// and the response reports what was actually searched. Covers the default parser
// and a custom (LLM-style) transformer injected via config.

import { test, expect } from 'bun:test';
import { createServer } from '../src/index.js';
import { SearchTransformer } from '@3sln/trove/core';

async function jsonReq(handle, method, path, body) {
  const res = await handle(new Request(`http://t${path}`, {
    method, headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function seed(vfs) {
  await vfs.writeFile('dune.txt', 'Dune: desert planet Arrakis, spice, sandworms.', { contentType: 'text/plain' });
  const fav = await vfs.writeFile('beach.txt', 'A sunny day at the beach with friends.', { contentType: 'text/plain' });
  await vfs.metadata.setContribution(fav.id, 'user', { tags: { fav: 'yes' } });
}

test('/api/query default parser: free text + #tag filter, reports resolved', async () => {
  const { handle, vfs } = await createServer();
  await seed(vfs);

  const free = await jsonReq(handle, 'POST', '/api/query', { q: 'spice desert' });
  expect(free.json.results[0].node.name).toBe('dune.txt');
  expect(free.json.resolved.source).toBe('parse');
  expect(free.json.resolved.semanticText).toBe('spice desert');
  expect(free.json.resolved.tagFilters).toEqual([]);

  const tagged = await jsonReq(handle, 'POST', '/api/query', { q: '#fav' });
  expect(tagged.json.results.map((r) => r.node.name)).toEqual(['beach.txt']);
  expect(tagged.json.resolved.tagFilters).toEqual([{ key: 'fav', present: true }]);
});

test('/api/query with a custom transformer reports the interpreted query', async () => {
  class FakeLlm extends SearchTransformer {
    async transform(raw) {
      // Pretend the model turned prose into semantic text + a tag filter.
      return { semanticText: 'beach', tagFilters: [{ key: 'fav', present: true }], source: 'llm' };
    }
  }
  const { handle, vfs } = await createServer({ searchTransformer: new FakeLlm() });
  await seed(vfs);

  const res = await jsonReq(handle, 'POST', '/api/query', { q: 'that sunny outing I liked' });
  expect(res.json.resolved.source).toBe('llm');
  expect(res.json.resolved.semanticText).toBe('beach');
  // Semantic hit on "beach" narrowed to #fav → only beach.txt.
  expect(res.json.results.map((r) => r.node.name)).toEqual(['beach.txt']);
});
