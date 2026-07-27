// SearchTransformer — turns a user's raw search string into the structured query we
// actually dispatch: { semanticText, tagFilters }. The default just parses the
// `#tag` / `#key:op:value` grammar out of the string (deterministic, offline-safe).
// Inject a smarter one (e.g. an LLM that maps "photos from my trip last summer" to
// semantic text + tag/date filters) via config.searchTransformer.
//
// Whatever a transformer returns is what the search runs on, and the server reports
// it back to the client so the UI can honestly show what was searched.
//
// It may also say how the results want to be LOOKED AT. "photos from the trip last
// summer" is a request for a gallery as much as it is a query, and the transformer is
// the one thing in the stack that has read the sentence — by the time results come back
// all anyone can do is guess from content types. So `view` rides along on the resolved
// query, and the client treats it as the suggestion it is.

import { TroveError } from '../errors.js';

/**
 * @typedef {object} ResolvedQuery
 * @property {string} semanticText what to search for
 * @property {Array<object>} tagFilters structured filters to narrow it by
 * @property {string} [source] how it was resolved — 'parse' or 'llm'
 * @property {string} [note] why, when it didn't go as planned
 * @property {string|null} [view] the id of a view the results would suit, from
 *   `ctx.views`. A suggestion: the client ignores an id it doesn't have, and never
 *   applies it over a view the user picked for themselves.
 */

/**
 * @typedef {object} SearchPrompt
 * @property {string} placeholder what to show in an empty search box
 * @property {string} [short] a phone-width version of the same
 * @property {string} [hint] one line explaining what the box accepts
 * @property {Array<{query: string, label?: string}>} [examples] queries worth trying
 */

export class SearchTransformer {
  /**
   * @param {string} rawQuery the user's input
   * @param {{ tagKeys?: string[], views?: Array<{id: string, title?: string}> }} [ctx]
   *   what the caller can tell us: the tag keys in use, and the views this client can
   *   draw with (so a `view` hint names one that exists rather than one we invented).
   * @returns {Promise<ResolvedQuery>}
   */
  async transform(rawQuery, ctx) {
    throw TroveError.unsupported('SearchTransformer.transform');
  }

  /**
   * What to tell the user this search box accepts.
   *
   * The transformer defines the grammar, so the transformer has to define the prompt.
   * A hardcoded "# filter by tag" is a lie the moment an LLM transformer is plugged in
   * and the right thing to type becomes a sentence — and it is the specific kind of lie
   * that teaches people the search doesn't work, because they type what the box told
   * them to and get nothing.
   *
   * @returns {SearchPrompt}
   */
  describe() {
    return { placeholder: 'Search files', short: 'Search' };
  }
}

// The `#tag` grammar (mirrors the client parser in web/src/bl/tagQuery.js):
//   #tag  present · #key:=v #key:!=v #key:<v #key:<=v #key:>v #key:>=v  · #key:v (= shorthand)
const TOKEN = /#([\w.-]+)(?::(<=|>=|!=|=|<|>)?("[^"]*"|[^#\s]+)?)?/g;

/** Parse `#tag`/`#key:op:value` filters out of `query`, returning the residual text. */
export function parseTagFilters(query) {
  const filters = [];
  let text = query || '';
  for (const m of (query || '').matchAll(TOKEN)) {
    const [, key, op, rawValue] = m;
    const value = rawValue && rawValue.startsWith('"') ? rawValue.slice(1, -1) : rawValue;
    filters.push(value == null || value === ''
      ? { key, present: true }
      : { key, op: op || '=', value, present: false });
    text = text.replace(m[0], ' ');
  }
  return { text: text.replace(/\s+/g, ' ').trim(), filters };
}

// Re-exported so existing importers keep working; the semantics live in tagMatch.js,
// which the sqlite store's SQL is also written to agree with.
export { matchTagFilters, matchesFilter, tagProps } from './tagMatch.js';

/** The default: deterministic `#tag` parsing, no external calls. */
export class ParsingSearchTransformer extends SearchTransformer {
  async transform(rawQuery) {
    const { text, filters } = parseTagFilters(rawQuery);
    return { semanticText: text, tagFilters: filters, source: 'parse' };
  }

  describe() {
    return {
      placeholder: 'Search files · # filter by tag',
      short: 'Search files',
      hint: 'Words match content and meaning. #tag narrows to items carrying that tag, '
        + 'and #key:value compares one — with =, !=, <, <=, > or >=.',
      examples: [
        { query: '#draft', label: 'everything tagged draft' },
        { query: '#year:>2023', label: 'a comparison on a tag value' },
        { query: 'sailing #draft', label: 'meaning and a tag together' },
      ],
    };
  }
}

/**
 * The views a client offered, cleaned up enough to put in a prompt.
 *
 * This list arrives from the client, so it is bounded before it becomes part of a system
 * prompt — not because a long one is dangerous, but because it is the caller's text in
 * our instructions and an unbounded field there is somebody else's budget.
 */
function viewChoices(views) {
  if (!Array.isArray(views)) return [];
  return views
    .filter((v) => v && typeof v.id === 'string' && v.id)
    .slice(0, 12)
    .map((v) => ({
      id: v.id.slice(0, 80),
      title: (typeof v.title === 'string' && v.title ? v.title : v.id).slice(0, 40),
    }));
}

// An LLM-assisted transformer for Cloudflare Workers AI (or any compatible runner).
// `run(model, { messages })` should return the model's text (Workers AI returns
// `{ response }`). It asks a cheap chat model to convert free text into
// { semanticText, tagFilters } given the known tag keys, and falls back to plain
// parsing if the model is unavailable or returns unusable output — so search never
// breaks because the LLM hiccuped.
export class WorkersAiSearchTransformer extends SearchTransformer {
  constructor({ ai, model = '@cf/meta/llama-3.1-8b-instruct', run } = {}) {
    super();
    // `ai` is a Workers AI binding ({ run(model, input) }); `run` overrides it.
    this._run = run || (ai ? (m, input) => ai.run(m, input) : null);
    this.model = model;
    this._fallback = new ParsingSearchTransformer();
  }

  describe() {
    // With a model in the loop the right thing to type is a sentence, so that is what
    // the box should ask for. The `#tag` grammar still works — explicit filters are
    // passed through untouched below — so it is mentioned rather than dropped.
    return {
      placeholder: 'Describe what you\'re looking for',
      short: 'Describe what you want',
      hint: 'Plain language works — "invoices from last spring". Explicit #tag filters '
        + 'are still applied exactly as written.',
      examples: [
        { query: 'photos from the trip last summer' },
        { query: 'contracts I haven\'t signed #draft', label: 'a sentence plus an exact filter' },
      ],
    };
  }

  async transform(rawQuery, ctx = {}) {
    // Explicit `#tag` filters are already structured — respect them and only let the
    // model reinterpret the residual free text.
    const parsed = parseTagFilters(rawQuery);
    if (!this._run || !parsed.text) return { semanticText: parsed.text, tagFilters: parsed.filters, source: 'parse' };
    try {
      const keys = (ctx.tagKeys || []).slice(0, 60);
      const views = viewChoices(ctx.views);
      const sys = 'You convert a user\'s file-search request into JSON: '
        + '{"semanticText": string, "tagFilters": [{"key":string,"op":"="|"!="|"<"|"<="|">"|">=","value":string}|{"key":string,"present":true}]'
        + (views.length ? ', "view": string|null' : '') + '}. '
        + 'Only use tag keys from this list: ' + JSON.stringify(keys) + '. '
        + (views.length
          // Asking for null explicitly, and saying when: a model given a list of options
          // and no way to decline will pick one every time, and a gallery forced onto a
          // search for meeting notes is worse than not having asked.
          ? 'If the request clearly implies how the results should be displayed, set "view" to one of '
            + JSON.stringify(views.map((v) => v.id)) + ' — ' + views.map((v) => `${v.id} is ${v.title}`).join(', ')
            + '. Otherwise set "view" to null. '
          : '')
        + 'Put the natural-language description of the content into semanticText. Output JSON only.';
      const out = await this._run(this.model, { messages: [{ role: 'system', content: sys }, { role: 'user', content: parsed.text }] });
      const textOut = typeof out === 'string' ? out : (out?.response || out?.result?.response || '');
      const json = JSON.parse((textOut.match(/\{[\s\S]*\}/) || [textOut])[0]);
      const semanticText = typeof json.semanticText === 'string' ? json.semanticText : parsed.text;
      const modelFilters = Array.isArray(json.tagFilters) ? json.tagFilters.filter((f) => f && f.key) : [];
      // Merge explicit user filters with the model's; explicit ones win.
      const tagFilters = [...parsed.filters, ...modelFilters];
      // Only a view we offered. A model that invents an id, or reaches for one this
      // client never mentioned, has said nothing.
      const view = views.some((v) => v.id === json.view) ? json.view : null;
      return { semanticText, tagFilters, source: 'llm', view };
    } catch (err) {
      return { semanticText: parsed.text, tagFilters: parsed.filters, source: 'parse', note: 'llm-unavailable' };
    }
  }
}
