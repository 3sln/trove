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

