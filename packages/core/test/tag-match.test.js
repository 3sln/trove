// One tag filter, three implementations (the JS matcher, the memory store, and SQL in
// the sqlite store) — and they have to agree, because a user's query goes through a
// different one depending on which store the deployment runs and whether they are
// online. When they disagreed, nothing errored: the same `#pages:120` simply returned
// different files.

import { test, expect } from 'bun:test';
import { MemoryStore, SqliteStore, LocalSqliteProvider, matchTagFilters } from '../src/index.js';
import { parseTagFilters } from '../src/search/transformer.js';

// Every case is (tags, query) → does this node match? The interesting ones are the four
// the sqlite store used to get wrong on its own.
const CASES = [
  // A NUMERIC tag. `json_extract` preserves JSON types, and the store bound
  // String(value) against it — so `#pages:120` matched nothing while `#pages:!=120`
  // matched the file.
  [{ pages: 120 }, '#pages:120', true],
  [{ pages: 120 }, '#pages:!=120', false],
  [{ pages: 120 }, '#pages:>100', true],
  [{ pages: 120 }, '#pages:<100', false],
  [{ pages: 120 }, '#pages', true],

  // `present` means present AND meaningful. `IS NOT NULL` counted an explicit `false`.
  [{ draft: false }, '#draft', false],
  [{ draft: true }, '#draft', true],
  [{ draft: '' }, '#draft', false],
  [{ draft: 0 }, '#draft', true], // zero is a value, not an absence
  [{}, '#draft', false],

  // Text compares case-insensitively — including the ordering operators, which the
  // server compared case-SENSITIVELY while the browser lowercased. `author:"alice"`
  // against `#author:>Bob` was false online and true offline.
  [{ author: 'Alice' }, '#author:alice', true],
  [{ author: 'alice' }, '#author:>Bob', false],
  [{ author: 'zoe' }, '#author:>Bob', true],
  [{ author: 'alice' }, '#author:!=bob', true],

  // Several filters are an AND.
  [{ pages: 120, author: 'Alice' }, '#pages:>100 #author:alice', true],
  [{ pages: 12, author: 'Alice' }, '#pages:>100 #author:alice', false],
];

test('the JS matcher answers each case', () => {
  for (const [tags, query, want] of CASES) {
    const { filters } = parseTagFilters(query);
    expect(`${query} on ${JSON.stringify(tags)} → ${matchTagFilters({ tags }, filters)}`)
      .toBe(`${query} on ${JSON.stringify(tags)} → ${want}`);
  }
});

test('the memory and sqlite stores agree with it, and with each other', async () => {
  const stores = {
    memory: new MemoryStore(),
    sqlite: new SqliteStore({ provider: new LocalSqliteProvider({ path: ':memory:' }) }),
  };
  for (const s of Object.values(stores)) await s.init();

  // One node per case, so a query's answer is "did this exact node come back".
  for (const [i, [tags]] of CASES.entries()) {
    for (const s of Object.values(stores)) {
      await s.create({ name: `n${i}.txt`, collectionId: 'default', meta: {} });
      const node = await s.getByName('default', `n${i}.txt`);
      await s.setContribution(node.id, 'trove+contrib:test.example/t/idx', { tags });
    }
  }

  for (const [i, [tags, query, want]] of CASES.entries()) {
    const { filters } = parseTagFilters(query);
    for (const [label, s] of Object.entries(stores)) {
      const hit = (await s.findByTags(filters, { limit: 100 })).some((n) => n.name === `n${i}.txt`);
      expect(`${label}: ${query} on ${JSON.stringify(tags)} → ${hit}`)
        .toBe(`${label}: ${query} on ${JSON.stringify(tags)} → ${want}`);
    }
  }
});

test('a filter matches meta as well as tags, and tags win', async () => {
  // The interface documents a filter as matching "merged tags (+ meta)", and both JS
  // matchers do — the SQL never looked at `meta` at all.
  const stores = {
    memory: new MemoryStore(),
    sqlite: new SqliteStore({ provider: new LocalSqliteProvider({ path: ':memory:' }) }),
  };
  for (const s of Object.values(stores)) await s.init();

  for (const [label, s] of Object.entries(stores)) {
    await s.create({ name: 'from-meta.txt', collectionId: 'default', meta: { project: 'apollo' } });
    const both = await s.create({ name: 'both.txt', collectionId: 'default', meta: { project: 'gemini' } });
    await s.setContribution(both.id, 'trove+contrib:test.example/t/idx', { tags: { project: 'apollo' } });

    const { filters } = parseTagFilters('#project:apollo');
    const names = (await s.findByTags(filters, { limit: 100 })).map((n) => n.name).sort();
    expect(`${label}: ${names.join(',')}`).toBe(`${label}: both.txt,from-meta.txt`);
  }
});
