// Multi-file plugins — native ESM without a bundler. A package can put its code
// under `src/` and use ordinary relative imports (`import './util.js'`); assets
// live anywhere else and are reached as opaque resources. We can't just let the
// sandboxed frame import these: it's on an opaque origin and can't fetch its own
// files, and a blob: module's base URL is meaningless so `./util.js` wouldn't
// resolve. So the host loads every `src/*.js` module as a blob: URL inside the
// frame and wires them together with an import map — and, because an import map is
// keyed by name (not text order), circular imports and any load order just work.
//
// The one preprocessing step: relative specifiers are rewritten to a canonical
// `trove:/<path>` key (resolved against the importing module) so they match the
// import map instead of resolving against the opaque blob base. We use
// es-module-lexer to find the exact specifier spans, so strings/comments/regex are
// never touched. The SDK is exposed as the bare specifier `trove`, so plugins can
// write either `import { activate } from 'trove'` or use the `globalThis.trove`
// the injected SDK also sets.

import { init, parse } from 'es-module-lexer';

const JS_RE = /\.m?js$/i;

/** A file that participates in the module graph (code under `src/`). */
export function isSourceModule(path) {
  return /^src\//i.test(path) && JS_RE.test(path);
}

/** Whether a package should run in ESM module mode (its entry is a src module). */
export function isModuleEntry(manifest) {
  return isSourceModule(manifest.entry || '');
}

function dirParts(p) {
  const i = p.lastIndexOf('/');
  return (i < 0 ? '' : p.slice(0, i)).split('/').filter(Boolean);
}

/** Resolve a relative specifier against the importer's package path. */
function resolvePath(importer, spec) {
  const stack = dirParts(importer);
  for (const part of spec.split('/')) {
    if (part === '' || part === '.') continue;
    else if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/**
 * Build the rewritten module set + entry for a package. Returns
 * { modules: { path: code }, entry } where each module's relative imports point at
 * canonical `trove:/<path>` keys. Only `src/*.js` files are included.
 */
export async function buildModuleGraph(pkg) {
  await init;
  const modules = {};
  for (const [path, bytes] of pkg.files) {
    if (isSourceModule(path)) modules[path] = new TextDecoder().decode(bytes);
  }
  const has = (p) => Object.prototype.hasOwnProperty.call(modules, p);
  const resolveModule = (importer, spec) => {
    const r = resolvePath(importer, spec);
    if (has(r)) return r;
    if (has(r + '.js')) return r + '.js';
    if (has(r + '.mjs')) return r + '.mjs';
    if (has(r + '/index.js')) return r + '/index.js';
    return r; // unresolved → import fails with a clear "no such module" error
  };
  const rewritten = {};
  for (const [path, code] of Object.entries(modules)) {
    rewritten[path] = rewriteSpecifiers(code, path, resolveModule);
  }
  return { modules: rewritten, entry: pkg.manifest.entry };
}

/** Rewrite relative import specifiers in one module to canonical map keys. */
export function rewriteSpecifiers(code, path, resolveModule) {
  const [imports] = parse(code);
  let out = '';
  let last = 0;
  for (const imp of imports) {
    if (imp.n == null) continue;        // dynamic import with a non-literal argument
    if (imp.n[0] !== '.') continue;     // only relative specifiers are remapped
    const key = 'trove:/' + resolveModule(path, imp.n);
    // Static spans exclude the quotes; dynamic import() spans include them.
    const replacement = imp.d === -1 ? key : JSON.stringify(key);
    out += code.slice(last, imp.s) + replacement;
    last = imp.e;
  }
  return out + code.slice(last);
}
