// Telling the user what the search box accepts, when what it accepts is configurable.
//
// The transformer decides the grammar. If the prompt is written into the client, then
// swapping the transformer leaves a box that instructs people to type something it no
// longer understands — and they will type it, get nothing, and conclude search is
// broken. So the prompt travels with the thing that defines it.

import { test, expect } from 'bun:test';
import {
  SearchTransformer, ParsingSearchTransformer, WorkersAiSearchTransformer,
} from '../src/search/transformer.js';

test('the default transformer describes the grammar it actually parses', async () => {
  const t = new ParsingSearchTransformer();
  const d = t.describe();
  expect(d.placeholder).toMatch(/#/); // it really does take #tag
  expect(d.hint).toMatch(/#key:value|#tag/);
  expect(d.examples.length).toBeGreaterThan(0);

  // The examples have to WORK, or they teach the wrong thing more convincingly than
  // no examples at all.
  for (const ex of d.examples) {
    const r = await t.transform(ex.query);
    const meaningful = r.tagFilters.length > 0 || r.semanticText.trim().length > 0;
    expect(meaningful).toBe(true);
  }
  const comparison = await t.transform('#year:>2023');
  expect(comparison.tagFilters).toEqual([{ key: 'year', op: '>', value: '2023', present: false }]);
});

test('an LLM transformer asks for a sentence instead', async () => {
  // This is the whole point: the same UI, a different deployment, a different prompt.
  const llm = new WorkersAiSearchTransformer({ run: async () => '{"semanticText":"x","tagFilters":[]}' });
  const d = llm.describe();
  expect(d.placeholder).not.toMatch(/#tag/);
  expect(d.placeholder).not.toBe(new ParsingSearchTransformer().describe().placeholder);
  // But it must not claim #tag stopped working, because it didn't — explicit filters
  // are still parsed out before the model ever sees the text.
  expect(d.hint).toMatch(/#tag/);
  const r = await llm.transform('invoices #draft');
  expect(r.tagFilters.some((f) => f.key === 'draft')).toBe(true);
});

test('a transformer that says nothing still gets a usable prompt', async () => {
  // Every field past `placeholder` is optional, and a custom transformer that overrides
  // only transform() must not produce an empty search box.
  class Bare extends SearchTransformer {
    async transform(q) { return { semanticText: q, tagFilters: [] }; }
  }
  const d = new Bare().describe();
  expect(d.placeholder.length).toBeGreaterThan(0);
  expect(d.short.length).toBeGreaterThan(0);
});

test('a short form exists for narrow screens, and it is actually shorter', async () => {
  for (const t of [new ParsingSearchTransformer(), new WorkersAiSearchTransformer({})]) {
    const d = t.describe();
    expect(d.short.length).toBeLessThanOrEqual(d.placeholder.length);
    // A phone search box is roughly 34 characters wide before it ellipsises.
    expect(d.short.length).toBeLessThanOrEqual(34);
  }
});
