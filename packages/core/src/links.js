// `trove:` — the URI that addresses an ITEM in the drive.
//
// There is no folder hierarchy. A collection is a flat namespace of uniquely-named
// items, and structure comes from items linking to each other — a markdown document
// that links its sources is what a folder used to be, except it can say *why* things
// belong together, an item can appear in several of them, and the grouping is
// searchable content rather than an invisible container.
//
// So a link has to be something a person can type into a markdown file:
//
//   trove:default?name=sailing.txt      canonical, by name
//   trove:default/sailing.txt           shorthand for the same thing
//   trove:default?id=fil_01H2X8F4KQ     by id — survives a rename, unreadable
//
// The selector is EXPLICIT (`?name=` vs `?id=`) rather than inferred from the shape
// of the segment: a name that happens to look like an id would otherwise resolve to
// something else entirely, and a link that silently retargets is worse than one that
// visibly breaks. The `/name` shorthand is unambiguous for the same reason — that
// slot only ever means a name.
//
// Names are unique per collection, which is what makes `?name=` resolve to exactly one
// item. Renaming therefore breaks inbound links, on purpose and visibly: the alternative
// is opaque ids nobody can hand-write, which would put linking back in the UI's hands.
// `?id=` is there for links a tool inserts, where stability matters more than legibility.

import { TroveError } from './errors.js';

export const TROVE_SCHEME = 'trove:';

// An item name is capped at 255 chars (isValidItemName), so a longer selector can never
// resolve to anything. Refusing it at parse time keeps garbage out of the links index
// rather than storing kilobytes that will never match.
const MAX_SELECTOR = 255;
// How many distinct links one item may record. A document is a grouping, not a database
// dump; past this the value is in the search index, not the link graph.
export const MAX_LINKS_PER_ITEM = 500;

// Collection ids are slugs (see CollectionService); a name is anything but a slash,
// since the pathname shorthand has to stop somewhere.
const COLLECTION_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Parse a `trove:` URI into `{ collection, by: 'name'|'id', value }`, or null if it
 * isn't one. Never throws — callers parse untrusted document text with this, where a
 * malformed link is a thing to render as broken, not an exception.
 */
export function parseTroveUri(uri) {
  if (typeof uri !== 'string' || !uri.toLowerCase().startsWith(TROVE_SCHEME)) return null;
  let url;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  // `trove:default/sailing.txt` → pathname "default/sailing.txt"; the slash-free case
  // is `trove:default?name=…`, where the whole pathname is the collection.
  const path = url.pathname;
  const slash = path.indexOf('/');
  const collection = slash < 0 ? path : path.slice(0, slash);
  if (!COLLECTION_RE.test(collection)) return null;

  const id = url.searchParams.get('id');
  const name = url.searchParams.get('name');
  let shorthand = '';
  if (slash >= 0) {
    // A malformed percent-escape is a malformed link, not an exception to propagate
    // out of a document render.
    try { shorthand = decodeURIComponent(path.slice(slash + 1)); } catch { return null; }
  }

  // Both selectors at once is a contradiction, not something to silently pick between.
  if (id != null && (name != null || shorthand)) return null;
  const by = id != null ? 'id' : 'name';
  const value = id != null ? id : (name != null ? name : shorthand);
  if (!value || value.length > MAX_SELECTOR) return null;
  return { collection, by, value };
}

/** Whether `uri` is a well-formed trove: reference. */
export function isTroveUri(uri) {
  return parseTroveUri(uri) != null;
}

/**
 * Build a `trove:` URI. `by` defaults to 'name' — the legible form, which is what
 * gets written into documents; pass 'id' for a link that must survive a rename.
 */
export function troveUri(node, by = 'name') {
  const collection = node?.collectionId || 'default';
  if (by === 'id') {
    if (!node?.id) throw TroveError.invalid('trove: link by id needs a node id');
    return `${TROVE_SCHEME}${collection}?id=${encodeURIComponent(node.id)}`;
  }
  if (!node?.name) throw TroveError.invalid('trove: link by name needs a node name');
  return `${TROVE_SCHEME}${collection}?name=${encodeURIComponent(node.name)}`;
}

/**
 * Every distinct `trove:` reference in a block of text, in first-appearance order.
 *
 * Deliberately scans raw text rather than parsing markdown: a link is just as real in
 * an HTML `href`, a bare mention, or a front-matter list, and the point of extraction
 * is to know what an item references — not to reproduce one renderer's idea of a link.
 * Trailing punctuation is trimmed so `see trove:default/a.md.` doesn't capture the dot.
 */
export function extractTroveLinks(text, { limit = MAX_LINKS_PER_ITEM } = {}) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  const seen = new Set();
  // Stop at whitespace and at the delimiters that wrap a URL in markdown/HTML.
  const re = /trove:[^\s<>"'`)\]}]+/gi;
  for (const m of text.matchAll(re)) {
    if (out.length >= limit) break;
    const raw = m[0].replace(/[.,;:!?]+$/, '');
    const parsed = parseTroveUri(raw);
    if (!parsed) continue;
    const canonical = `${TROVE_SCHEME}${parsed.collection}?${parsed.by}=${encodeURIComponent(parsed.value)}`;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({ uri: canonical, raw, ...parsed });
  }
  return out;
}

/**
 * The canonical form of a reference, for storing and comparing. Two links that address
 * the same item by the same selector must produce the same string, or backlinks would
 * miss `trove:default/a.md` when the target stored `trove:default?name=a.md`.
 */
export function canonicalTroveUri(uri) {
  const p = parseTroveUri(uri);
  return p ? `${TROVE_SCHEME}${p.collection}?${p.by}=${encodeURIComponent(p.value)}` : null;
}

/** Both canonical forms an item can be addressed by — what a backlink query looks for. */
export function troveUrisFor(node) {
  const out = [];
  if (node?.collectionId && node?.name) out.push(troveUri(node, 'name'));
  if (node?.collectionId && node?.id) out.push(troveUri(node, 'id'));
  return out;
}
