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
 * The canonical string for one address. The ONE place the template lives.
 *
 * There were five hand-written copies of it, which is five chances to get the encoding or
 * the separator subtly different — and `canonicalTroveUri`, whose whole docstring is
 * "two links that address the same item by the same selector must produce the same
 * string", was one of the copies rather than the source.
 */
export function formatTroveUri({ collection, by, value }) {
  return `${TROVE_SCHEME}${collection}?${by}=${encodeURIComponent(value)}`;
}

/**
 * Build a `trove:` URI. `by` defaults to 'name' — the legible form, which is what
 * gets written into documents; pass 'id' for a link that must survive a rename.
 */
export function troveUri(node, by = 'name') {
  const collection = node?.collectionId || 'default';
  if (by === 'id') {
    if (!node?.id) throw TroveError.invalid('trove: link by id needs a node id');
    return formatTroveUri({ collection, by: 'id', value: node.id });
  }
  if (!node?.name) throw TroveError.invalid('trove: link by name needs a node name');
  return formatTroveUri({ collection, by: 'name', value: node.name });
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
    const canonical = formatTroveUri(parsed);
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
  return p ? formatTroveUri(p) : null;
}

/** Both canonical forms an item can be addressed by — what a backlink query looks for. */
export function troveUrisFor(node) {
  const out = [];
  if (node?.collectionId && node?.name) out.push(troveUri(node, 'name'));
  if (node?.collectionId && node?.id) out.push(troveUri(node, 'id'));
  return out;
}

// --- shareable web links -------------------------------------------------------
//
// `trove:` addresses an item INSIDE the drive: it is what one document writes to link
// another, and it means nothing to a browser. A share link is the other half — a URL you
// can paste into a message so that someone else's browser opens the same item.
//
// They are deliberately the same addressing, not two competing schemes. A share link is a
// `trove:` URI wearing an http(s) coat: same collection, same explicit `name`-or-`id`
// selector, same refusal to infer which one you meant. So anything that can already
// resolve a `trove:` URI can resolve a share link by parsing it back, and a rename breaks
// both in the same visible way rather than one silently retargeting.
//
// The path form — /c/<collection>/i/<selector> — rather than the query form
// `?coll=&item=`. Both put the ids in the URL and therefore in server logs and browser
// history, so that is not the difference; the path reads as a location, survives being
// truncated in a chat client more gracefully, and leaves the query string free for the
// things that genuinely are parameters.
//
// Nothing secret ever rides in one. An encrypted collection's key is not in the link and
// must not be: a link is pasted into chats, logged by proxies, and kept in history
// forever. The recipient gets the item because they are allowed the collection, which is
// the same rule as everywhere else here.

/** The path a share link uses. Exported so a client router and the server agree. */
export const SHARE_PATH = '/c';

/**
 * A URL that opens this item in a browser.
 *
 * @param {object} node
 * @param {string} [origin] where the drive is served; omitted gives a root-relative link
 * @param {'name'|'id'} [by] `name` reads better and breaks on rename; `id` is the reverse
 */
export function shareUrl(node, origin = '', by = 'name') {
  if (!node?.collectionId) throw TroveError.invalid('An item needs a collection to be linked to');
  const selector = by === 'id'
    ? `id:${node.id}`
    : encodeURIComponent(node.name);
  if (!selector || (by === 'id' && !node.id)) throw TroveError.invalid('Nothing to link to');
  const path = `${SHARE_PATH}/${encodeURIComponent(node.collectionId)}/i/${selector}`;
  return origin ? `${String(origin).replace(/\/$/, '')}${path}` : path;
}

/**
 * Read a share link back, from a full URL or just a path.
 *
 * Returns the same shape `parseTroveUri` does, so a caller resolves either without caring
 * which it was handed. Null rather than a throw: this parses whatever was in the address
 * bar, and a URL that is not a share link is an ordinary page, not an error.
 */
export function parseShareUrl(url) {
  let path;
  try {
    path = url.startsWith('/') ? url : new URL(url).pathname;
  } catch {
    return null;
  }
  const m = /^\/c\/([^/]+)\/i\/(.+)$/.exec(path);
  if (!m) return null;
  let collection;
  let raw;
  try {
    collection = decodeURIComponent(m[1]);
    raw = decodeURIComponent(m[2]);
  } catch {
    return null; // a malformed escape is not a link to anything
  }
  if (!COLLECTION_RE.test(collection)) return null;
  // `id:` is the explicit selector, mirroring `?id=` — a name is never guessed at just
  // because it happens to look like an id.
  const byId = raw.startsWith('id:');
  const value = byId ? raw.slice(3) : raw;
  if (!value || value.length > MAX_SELECTOR) return null;
  return { collection, by: byId ? 'id' : 'name', value };
}

/** The `trove:` URI a share link denotes — the two are the same address. */
export function troveUriFromShareUrl(url) {
  const parsed = parseShareUrl(url);
  if (!parsed) return null;
  return formatTroveUri(parsed);
}
