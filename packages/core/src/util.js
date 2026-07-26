// Small runtime-agnostic helpers. No Node or browser globals beyond what's
// standard in both (crypto.randomUUID, TextEncoder, Web Streams).

import { TroveError } from './errors.js';

/** URL-safe unique id. */
export function newId(prefix = '') {
  const uuid = (globalThis.crypto?.randomUUID?.() ?? fallbackUuid()).replace(/-/g, '');
  return prefix ? `${prefix}_${uuid}` : uuid;
}

function fallbackUuid() {
  // Only used where crypto.randomUUID is unavailable; good enough for ids.
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

// ---- item names -------------------------------------------------------------
// There are no paths: a collection is a flat namespace, and a name is the whole
// address within it. Slashes are rejected because a name has to survive the `/name`
// shorthand of a trove: link without splitting.

/**
 * A user-visible ITEM name. Distinct from the `isValidName` in plugins/identity.js,
 * which validates a *name segment in the contribution address space* — same word, very
 * different rule, so they get different names rather than colliding across the two
 * public entry points that export them.
 */
export function isValidItemName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 255 &&
    !name.includes('/') &&
    name !== '.' &&
    name !== '..' &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f]/.test(name)
  );
}

/** The lowercased extension of an item name, including the dot ('' if none). */
export function extname(name) {
  const i = String(name || '').lastIndexOf('.');
  return i > 0 ? String(name).slice(i).toLowerCase() : '';
}

/**
 * Does a contribution/opener/indexer `selector` match a file node? One matcher shared
 * by the client contribution registry and the server indexers so they can't drift.
 * A selector has any of: `match(node)` (a predicate, built-ins only), `ext` (with or
 * without leading dot), `mime`/`contentType` (exact or a `type/*` prefix).
 */
export function selectorMatches(selector, node) {
  if (!selector || !node) return false;
  if (typeof selector.match === 'function') {
    try { if (selector.match(node)) return true; } catch { /* ignore a bad matcher */ }
  }
  const ext = extname(node.name || '');
  if (ext && (selector.ext || []).some((e) => (e.startsWith('.') ? e : '.' + e).toLowerCase() === ext)) return true;
  const ct = node.contentType || '';
  const mimes = selector.mime || selector.contentType || [];
  return mimes.some((m) => (m.endsWith('/*') ? ct.startsWith(m.slice(0, -1)) : ct === m));
}

// ---- byte helpers -----------------------------------------------------------

/** Concatenate Uint8Array chunks into one. */
export function concatBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** Drain a web ReadableStream into a single Uint8Array. */
export async function readAll(stream) {
  const reader = stream.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value));
  }
  return concatBytes(chunks);
}


/**
 * Refuse a URL that would make the server fetch something on its own network.
 *
 * Anywhere a caller supplies a URL the SERVER will later request, this is the gate. The
 * dangerous targets are not exotic: `169.254.169.254` is cloud instance metadata (and
 * with it, credentials), `127.0.0.1` and private ranges are whatever else the box is
 * running, and `.internal`/`.local` are the names those things usually have.
 *
 * DNS names that resolve to private addresses are a residual risk — rebinding cannot be
 * settled at this layer — so a deployment that cares should egress-filter too.
 *
 * @param {string} url
 * @param {string} what named in the error, so the message says which field was wrong
 */
export function assertPublicUrl(url, what = 'URL') {
  let u;
  try { u = new URL(String(url)); } catch { throw TroveError.invalid(`${what} is not a valid URL`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw TroveError.invalid(`${what} must be http(s)`);
  }
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    throw TroveError.invalid(`${what} points at an internal host`);
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168)
      || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || a >= 224) {
      throw TroveError.invalid(`${what} points at a private address`);
    }
  }
  if (h.includes(':') || h.startsWith('[')) throw TroveError.invalid(`${what} may not be an IP literal`);
  return u;
}
