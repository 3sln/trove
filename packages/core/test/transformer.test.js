// SearchTransformer: the default `#tag` parser and the Workers-AI transformer
// (driven by a fake runner), plus the graceful fallback when the model misbehaves.

import { test, expect } from 'bun:test';
import { ParsingSearchTransformer, WorkersAiSearchTransformer, parseTagFilters, matchTagFilters } from '../src/search/transformer.js';

test('ParsingSearchTransformer extracts #tag filters + residual text', async () => {
  const t = new ParsingSearchTransformer();
  const r = await t.transform('sunsets over the bay #fav #rating:>=4');
  expect(r.source).toBe('parse');
  expect(r.semanticText).toBe('sunsets over the bay');
  expect(r.tagFilters).toEqual([
    { key: 'fav', present: true },
    { key: 'rating', op: '>=', value: '4', present: false },
  ]);
});

test('matchTagFilters honours presence + numeric/string ops over node.tags + meta', () => {
  const node = { tags: { fav: 'yes', rating: '5' }, meta: { status: 'done' } };
  expect(matchTagFilters(node, parseTagFilters('#fav').filters)).toBe(true);
  expect(matchTagFilters(node, parseTagFilters('#rating:>=4').filters)).toBe(true);
  expect(matchTagFilters(node, parseTagFilters('#rating:>5').filters)).toBe(false);
  expect(matchTagFilters(node, parseTagFilters('#status:=done').filters)).toBe(true);
  expect(matchTagFilters(node, parseTagFilters('#missing').filters)).toBe(false);
});

test('WorkersAiSearchTransformer maps free text to semanticText + tag filters', async () => {
  const run = async (_model, { messages }) => {
    // A fake "model": echo a plausible structured interpretation.
    expect(messages[0].role).toBe('system');
    return { response: JSON.stringify({ semanticText: 'beach photos', tagFilters: [{ key: 'year', op: '=', value: '2023' }] }) };
  };
  const t = new WorkersAiSearchTransformer({ run });
  const r = await t.transform('beach pics from 2023');
  expect(r.source).toBe('llm');
  expect(r.semanticText).toBe('beach photos');
  expect(r.tagFilters).toContainEqual({ key: 'year', op: '=', value: '2023' });
});

test('WorkersAiSearchTransformer keeps explicit #tag filters and falls back on bad output', async () => {
  const run = async () => ({ response: 'not json at all' });
  const t = new WorkersAiSearchTransformer({ run });
  const r = await t.transform('old invoices #fav');
  // Explicit filter preserved; falls back to parsing when the model output is unusable.
  expect(r.tagFilters).toContainEqual({ key: 'fav', present: true });
  expect(r.source).toBe('parse');
  expect(r.note).toBe('llm-unavailable');
});
