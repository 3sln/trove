// One tag matcher, for everybody.
//
// There were four: this logic in `transformer.js` (post-filtering semantic results), a
// near-copy in the memory metadata store, a third in the browser (used by the offline
// path), and SQL in the sqlite store. Each pair "mirrored" the others in a comment and
// diverged in fact:
//
//   - the client lowercased both operands for `<`/`<=`/`>`/`>=`; the server did not, so
//     `#author:>Bob` against `author: "alice"` was false online and true offline;
//   - the sqlite store bound `String(value)` against `json_extract`, which preserves JSON
//     types, so a numeric tag `pages: 120` matched `#pages:!=120` and not `#pages:120`;
//   - the sqlite store treated `present` as `IS NOT NULL`, so a tag explicitly set to
//     `false` counted as present — everywhere else it does not;
//   - the sqlite store never consulted `meta`, which the interface documents as part of
//     what a filter matches.
//
// So the semantics live here, once, and the SQL in `metadata/sqlite.js` is written to
// agree with THIS file rather than with its own history.
//
// The rules:
//   present   the tag exists and is not `false` and not `''`
//   = / !=    numeric compare when BOTH sides are numbers, else case-insensitive text
//   < <= > >= same, and text comparison is case-insensitive (it was not on the server,
//             which is the one difference a user could actually observe between an
//             online and an offline search)

/** A node's filterable properties: `meta`, overlaid by its merged tags. */
export function tagProps(node, mergedTags = null) {
  return { ...(node?.meta || {}), ...(mergedTags || node?.tags || {}) };
}

/** Does one value satisfy one parsed filter? */
export function matchesFilter(value, filter) {
  if (filter.present) return value != null && value !== false && value !== '';
  if (value == null) return false;
  const na = Number(value);
  const nb = Number(filter.value);
  // `Number('')` is 0, which would make an empty string compare as a number — hence
  // the explicit emptiness checks rather than `!Number.isNaN` alone.
  const numeric = value !== '' && value !== true && value !== false
    && filter.value !== '' && filter.value != null
    && !Number.isNaN(na) && !Number.isNaN(nb);
  const x = numeric ? na : String(value).toLowerCase();
  const y = numeric ? nb : String(filter.value).toLowerCase();
  switch (filter.op) {
    case '!=': return x !== y;
    case '<': return x < y;
    case '<=': return x <= y;
    case '>': return x > y;
    case '>=': return x >= y;
    default: return x === y;
  }
}

/** Does a node satisfy every filter? `mergedTags` when the caller already computed them. */
export function matchTagFilters(node, filters, mergedTags = null) {
  const props = tagProps(node, mergedTags);
  return (filters || []).every((f) => matchesFilter(props[f.key], f));
}
