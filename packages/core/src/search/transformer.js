// SearchTransformer — turns a user's raw search string into the structured query we
// actually dispatch: { semanticText, tagFilters }. The default just parses the
// `#tag` / `#key:op:value` grammar out of the string (deterministic, offline-safe).
// Inject a smarter one (e.g. an LLM that maps "photos from my trip last summer" to
// semantic text + tag/date filters) via config.searchTransformer.
//
// Whatever a transformer returns is what the search runs on, and the server reports
// it back to the client so the UI can honestly show what was searched.

import { TroveError } from '../errors.js';

/** @typedef {{ semanticText: string, tagFilters: Array<object>, source?: string, note?: string }} ResolvedQuery */

export class SearchTransformer {
  /**
   * @param {string} rawQuery the user's input
   * @param {{ tagKeys?: string[] }} [ctx] hints (known tag keys, etc.)
   * @returns {Promise<ResolvedQuery>}
   */
  async transform(rawQuery, ctx) {
    throw TroveError.unsupported('SearchTransformer.transform');
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

/** Match a node's merged tags (+ meta) against parsed filters. Used to post-filter
 * semantic results by tags, and mirrors the client matcher. */
export function matchTagFilters(node, filters) {
  const props = { ...(node.meta || {}), ...(node.tags || {}) };
  return (filters || []).every((f) => {
    const v = props[f.key];
    if (f.present) return v != null && v !== false && v !== '';
    if (v == null) return false;
    const na = Number(v);
    const nb = Number(f.value);
    const numeric = !Number.isNaN(na) && !Number.isNaN(nb);
    switch (f.op) {
      case '!=': return String(v).toLowerCase() !== String(f.value).toLowerCase();
      case '<': return numeric ? na < nb : String(v) < String(f.value);
      case '<=': return numeric ? na <= nb : String(v) <= String(f.value);
      case '>': return numeric ? na > nb : String(v) > String(f.value);
      case '>=': return numeric ? na >= nb : String(v) >= String(f.value);
      default: return numeric ? na === nb : String(v).toLowerCase() === String(f.value).toLowerCase();
    }
  });
}

/** The default: deterministic `#tag` parsing, no external calls. */
export class ParsingSearchTransformer extends SearchTransformer {
  async transform(rawQuery) {
    const { text, filters } = parseTagFilters(rawQuery);
    return { semanticText: text, tagFilters: filters, source: 'parse' };
  }
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

  async transform(rawQuery, ctx = {}) {
    // Explicit `#tag` filters are already structured — respect them and only let the
    // model reinterpret the residual free text.
    const parsed = parseTagFilters(rawQuery);
    if (!this._run || !parsed.text) return { semanticText: parsed.text, tagFilters: parsed.filters, source: 'parse' };
    try {
      const keys = (ctx.tagKeys || []).slice(0, 60);
      const sys = 'You convert a user\'s file-search request into JSON: '
        + '{"semanticText": string, "tagFilters": [{"key":string,"op":"="|"!="|"<"|"<="|">"|">=","value":string}|{"key":string,"present":true}]}. '
        + 'Only use tag keys from this list: ' + JSON.stringify(keys) + '. '
        + 'Put the natural-language description of the content into semanticText. Output JSON only.';
      const out = await this._run(this.model, { messages: [{ role: 'system', content: sys }, { role: 'user', content: parsed.text }] });
      const textOut = typeof out === 'string' ? out : (out?.response || out?.result?.response || '');
      const json = JSON.parse((textOut.match(/\{[\s\S]*\}/) || [textOut])[0]);
      const semanticText = typeof json.semanticText === 'string' ? json.semanticText : parsed.text;
      const modelFilters = Array.isArray(json.tagFilters) ? json.tagFilters.filter((f) => f && f.key) : [];
      // Merge explicit user filters with the model's; explicit ones win.
      const tagFilters = [...parsed.filters, ...modelFilters];
      return { semanticText, tagFilters, source: 'llm' };
    } catch (err) {
      return { semanticText: parsed.text, tagFilters: parsed.filters, source: 'parse', note: 'llm-unavailable' };
    }
  }
}
