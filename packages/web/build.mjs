// Production build (replaces `vite build`). Runs under Bun: bundles the ESM entry
// (Bun natively inlines `with { type: 'text' }` imports), bundles the stylesheet,
// emits hashed assets + sourcemaps, copies the static public/ files, and writes
// dist/index.html pointing at the built files.
//
//   bun build.mjs
//
// Node-incompatible on purpose in one spot only — Bun.build — which is fine: the
// build tool is Bun, while the server runtime stays Node-compatible.

import { rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

async function bundle(entry, label, opts = {}) {
  const out = await Bun.build({
    entrypoints: [path.join(root, entry)],
    outdir: dist,
    // All three, spelled out. A bare string sets the ENTRY pattern only, so split
    // chunks kept the default and landed at the dist root — hashed, but sitting beside
    // index.html and sw.js, which are not. That matters because the cache policy is a
    // path rule: `/assets/*` is immutable because everything under it is
    // content-addressed, and a 40 kB chunk outside that prefix is either served
    // uncached or drags the rule out to cover files that must stay revalidated.
    // Chunks keep their own prefix rather than reusing [name]: a chunk split out of
    // main.js is also called "main", so sharing the pattern puts two unrelated
    // `main-<hash>.js` next to each other, one of them the entry point and nothing in
    // the name to say which.
    naming: {
      entry: 'assets/[name]-[hash].[ext]',
      chunk: 'assets/chunk-[hash].[ext]',
      asset: 'assets/[name]-[hash].[ext]',
    },
    minify: true,
    sourcemap: 'linked',
    target: 'browser',
    ...opts,
  });
  if (!out.success) {
    console.error(`build failed (${label}):\n` + out.logs.map(String).join('\n'));
    process.exit(1);
  }
  return out;
}

// Split the JS so heavy, rarely-used dynamic imports (e.g. sql.js for plugin
// client storage) load on demand rather than bloating the entry bundle.
const js = await bundle('src/main.js', 'js', { splitting: true });
const css = await bundle('src/styles.css', 'css');

const rel = (o) => '/' + path.relative(dist, o.path).replace(/\\/g, '/');
const jsPath = rel(js.outputs.find((o) => o.kind === 'entry-point'));
const cssPath = rel(css.outputs.find((o) => o.path.endsWith('.css')));

// Static assets served at the root (icon.svg, manifest.webmanifest, sw.js).
await cp(path.join(root, 'public'), dist, { recursive: true });

// sql.js wasm for client-side plugin storage — served at /sql-wasm.wasm.
const require = createRequire(import.meta.url);
await cp(require.resolve('sql.js/dist/sql-wasm.wasm'), path.join(dist, 'sql-wasm.wasm'));

// index.html → point at the built, hashed files.
let html = await readFile(path.join(root, 'index.html'), 'utf8');
html = html.replace('/src/styles.css', cssPath).replace('/src/main.js', jsPath);
await writeFile(path.join(dist, 'index.html'), html);

console.log(`built ${jsPath} + ${cssPath}`);
