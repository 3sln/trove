// Parse `#tag` / `#key:op:value` filter tokens out of a launcher query and match
// nodes against them. Grammar (each token, space-separated):
//   #tag              → the property/tag is present
//   #key:=v  #key:!=v #key:<v #key:<=v #key:>v #key:>=v  → compare
//   #key:v            → equality shorthand (same as #key:=v)
// Values may be "quoted" to include spaces. Comparisons are numeric when both
// sides parse as numbers, otherwise case-insensitive string comparisons.

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

/** The flat property map a node exposes to filters: user meta + merged tags
 * (all contributors' tags, e.g. user tags + indexer-contributed tags). */
function nodeProps(node) {
  return { ...(node.meta || {}), ...(node.tags || {}) };
}

function compare(a, op, b) {
  const na = Number(a);
  const nb = Number(b);
  const numeric = a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb);
  const x = numeric ? na : String(a).toLowerCase();
  const y = numeric ? nb : String(b).toLowerCase();
  switch (op) {
    case '=': return x === y;
    case '!=': return x !== y;
    case '<': return x < y;
    case '<=': return x <= y;
    case '>': return x > y;
    case '>=': return x >= y;
    default: return false;
  }
}

/** True if `node` satisfies ALL filters (AND). */
export function matchesTagFilters(node, filters) {
  if (!filters || !filters.length) return true;
  const props = nodeProps(node);
  return filters.every((f) => {
    const v = props[f.key];
    if (f.present) return v != null && v !== false && v !== '';
    if (v == null) return false;
    return compare(v, f.op, f.value);
  });
}

/** Short human label for a filter (for the results heading). */
export function filterLabel(f) {
  return f.present ? `#${f.key}` : `#${f.key}:${f.op}${f.value}`;
}
