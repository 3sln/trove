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

// The transformer is the only thing in the stack that read the user's sentence. "photos
// from the trip" asks for a gallery as much as it asks for files, and by the time the
// results are back all anyone can do is guess from content types — so a `view` hint
// rides along on the resolved query.
test('a transformer may suggest a view, but only one the client offered', async () => {
  const VIEWS = [{ id: 'core.view.list', title: 'List' }, { id: 'core.view.grid', title: 'Grid' }];
  const answering = (json) => new WorkersAiSearchTransformer({ run: async () => ({ response: JSON.stringify(json) }) });

  const picked = await answering({ semanticText: 'beach photos', tagFilters: [], view: 'core.view.grid' })
    .transform('beach pics', { views: VIEWS });
  expect(picked.view).toBe('core.view.grid');

  // An id nobody offered is not a suggestion, it is a guess about another deployment.
  const invented = await answering({ semanticText: 'beach photos', tagFilters: [], view: 'acme.gallery' })
    .transform('beach pics', { views: VIEWS });
  expect(invented.view).toBe(null);

  // Declining is a real answer, and the prompt has to ask for it — a model handed a list
  // of options with no way out picks one every time.
  const declined = await answering({ semanticText: 'meeting notes', tagFilters: [], view: null })
    .transform('notes from the standup', { views: VIEWS });
  expect(declined.view).toBe(null);

  // No views offered → nothing to suggest, and the prompt never mentions them.
  let sys = '';
  const bare = new WorkersAiSearchTransformer({
    run: async (_m, { messages }) => { sys = messages[0].content; return { response: '{"semanticText":"x","tagFilters":[]}' }; },
  });
  expect((await bare.transform('beach pics')).view).toBe(null);
  expect(sys).not.toContain('"view"');
});

test('the view list a client sends is bounded before it becomes part of a prompt', async () => {
  let sys = '';
  const t = new WorkersAiSearchTransformer({
    run: async (_m, { messages }) => { sys = messages[0].content; return { response: '{"semanticText":"x","tagFilters":[]}' }; },
  });
  await t.transform('anything', {
    views: [
      ...Array.from({ length: 40 }, (_, i) => ({ id: `core.view.v${i}`, title: 'x'.repeat(200) })),
      { id: 'x'.repeat(500), title: 'huge' },
      null, {}, { title: 'no id' }, // junk a client can send and a prompt must not carry
    ],
  });
  expect(sys.length).toBeLessThan(4000);
  expect(sys).toContain('core.view.v0');
  expect(sys).not.toContain('core.view.v20');
});
