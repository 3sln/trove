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
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

async function bundle(entry, label) {
  const out = await Bun.build({
    entrypoints: [path.join(root, entry)],
    outdir: dist,
    naming: 'assets/[name]-[hash].[ext]',
    minify: true,
    sourcemap: 'linked',
    target: 'browser',
  });
  if (!out.success) {
    console.error(`build failed (${label}):\n` + out.logs.map(String).join('\n'));
    process.exit(1);
  }
  return out;
}

const js = await bundle('src/main.js', 'js');
const css = await bundle('src/styles.css', 'css');

const rel = (o) => '/' + path.relative(dist, o.path).replace(/\\/g, '/');
const jsPath = rel(js.outputs.find((o) => o.kind === 'entry-point'));
const cssPath = rel(css.outputs.find((o) => o.path.endsWith('.css')));

// Static assets served at the root (icon.svg, manifest.webmanifest, sw.js).
await cp(path.join(root, 'public'), dist, { recursive: true });

// index.html → point at the built, hashed files.
let html = await readFile(path.join(root, 'index.html'), 'utf8');
html = html.replace('/src/styles.css', cssPath).replace('/src/main.js', jsPath);
await writeFile(path.join(dist, 'index.html'), html);

console.log(`built ${jsPath} + ${cssPath}`);
