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

// ---- POSIX-style path handling ---------------------------------------------
// Trove uses forward-slash virtual paths everywhere, independent of the host
// filesystem. Roots are '/', segments never contain slashes, '.'/'..' and empty
// segments are rejected (no traversal) at the boundary.

export function normalizePath(p) {
  if (typeof p !== 'string') throw TroveError.invalid('Path must be a string');
  // collapse repeats, strip trailing slash (except root)
  const parts = p.split('/').filter((s) => s.length > 0);
  for (const seg of parts) {
    if (seg === '.' || seg === '..') {
      throw TroveError.invalid(`Illegal path segment "${seg}"`);
    }
  }
  return '/' + parts.join('/');
}

export function isValidName(name) {
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

export function joinPath(dir, name) {
  if (!isValidName(name)) throw TroveError.invalid(`Invalid name "${name}"`);
  const base = normalizePath(dir);
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

export function parentPath(p) {
  const np = normalizePath(p);
  if (np === '/') return null;
  const idx = np.lastIndexOf('/');
  return idx === 0 ? '/' : np.slice(0, idx);
}

export function basename(p) {
  const np = normalizePath(p);
  return np === '/' ? '' : np.slice(np.lastIndexOf('/') + 1);
}

export function extname(name) {
  const b = basename(name) || name;
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i).toLowerCase() : '';
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

