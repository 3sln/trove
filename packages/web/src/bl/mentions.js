// The `@someone` syntax in a comment body.
//
// A sibling of bl/tagQuery.js, which parses the `#tag` syntax — and it sat in the social
// COMPONENT instead, a regex splitting a text format mid-render. Parsing the drive's own
// notation is business-layer work wherever it happens to be displayed, and having half of
// it here and half of it in a view is how the two end up disagreeing about what a name
// may contain.
//
// Two spellings, because they arrive from different places. The resolved form
// `@[Display Name](user-id)` is what the server writes once it knows who was meant; the
// bare form `@handle` is what someone types before anything has resolved it.

const MENTION = /@\[([^\]]+)\]\(([^)]+)\)|(?:^|\s)@([a-zA-Z0-9._@-]{2,})/g;

/**
 * Split a comment body into runs of plain text and mentions.
 *
 * @param {string} body
 * @returns {Array<{type: 'text', value: string} | {type: 'mention', name: string, id: string|null}>}
 */
export function parseMentions(body) {
  const text = body || '';
  const out = [];
  const re = new RegExp(MENTION.source, 'g'); // own lastIndex — the module-level one is shared
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    // The bare form's match deliberately includes the space in front of the `@`, so that
    // "a@b" is an address rather than a mention. That leading space belongs to the text
    // run, not to the mention.
    const bare = !!m[3];
    const start = m.index + (bare && m[0].startsWith(' ') ? 1 : 0);
    if (start > last) out.push({ type: 'text', value: text.slice(last, start) });
    out.push({ type: 'mention', name: m[1] || m[3], id: m[2] || null });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}
