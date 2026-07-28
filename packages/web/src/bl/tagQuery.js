// Parse `#tag` / `#key:op:value` filter tokens out of a launcher query and match
// nodes against them. Grammar (each token, space-separated):
//   #tag              → the property/tag is present
//   #key:=v  #key:!=v #key:<v #key:<=v #key:>v #key:>=v  → compare
//   #key:v            → equality shorthand (same as #key:=v)
// Values may be "quoted" to include spaces. Comparisons are numeric when both
// sides parse as numbers, otherwise case-insensitive string comparisons.

import { matchTagFilters } from '@3sln/trove/core/search/tagMatch.js';

const TOKEN = /#([\w.-]+)(?::(<=|>=|!=|=|<|>)?("[^"]*"|[^#\s]+)?)?/g;

/** @returns {{ text: string, filters: {key,op,value,present}[] }} */
export function parseTagQuery(query) {
  const filters = [];
  let text = query;
  for (const m of query.matchAll(TOKEN)) {
    const [, key, op, rawValue] = m;
    const value = rawValue && rawValue.startsWith('"') ? rawValue.slice(1, -1) : rawValue;
    filters.push(value == null || value === ''
      ? { key, present: true }
      : { key, op: op || '=', value, present: false });
    text = text.replace(m[0], ' ');
  }
  return { text: text.replace(/\s+/g, ' ').trim(), filters };
}

/**
 * True if `node` satisfies ALL filters (AND).
 *
 * Delegates to core rather than re-implementing. This file had its own copy, and the
 * two drifted on the ordering operators — the client lowercased both operands, the
 * server did not — so `#author:>Bob` against `author: "alice"` answered differently
 * online and offline. Same query, same drive, different files.
 */
export function matchesTagFilters(node, filters) {
  if (!filters || !filters.length) return true;
  return matchTagFilters(node, filters);
}

/** Short human label for a filter (for the results heading). */
export function filterLabel(f) {
  return f.present ? `#${f.key}` : `#${f.key}:${f.op}${f.value}`;
}
