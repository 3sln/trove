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

/** True when `child` is `ancestor` or lives beneath it. */
export function isDescendant(ancestor, child) {
  const a = normalizePath(ancestor);
  const c = normalizePath(child);
  if (a === '/') return true;
  return c === a || c.startsWith(a + '/');
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

export function humanBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Deferred: a promise plus its resolve/reject, for coordinating async flows. */
export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
