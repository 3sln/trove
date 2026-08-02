// Build a plugin into the zip the server will re-parse.
//
// The output is byte-for-byte what a user would drag into the install dialog. That is the
// point: there is no privileged path for our own plugins, so anything wrong with the
// package is wrong before it reaches anybody, and the install review shows the same
// capability list a stranger's plugin would.
//
//   bun plugins/build.mjs                 every plugin
//   bun plugins/build.mjs audiobook       one
//
// Bundled with Bun rather than shipped as loose modules because a plugin's entry is
// fetched as ONE module tree by the sandboxed frame, and every extra file is another
// round trip over the port before a viewer can draw anything.

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const root = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

/** A directory here is a plugin if it has a manifest. Nothing else is a signal. */
async function plugins() {
  const entries = await readdir(root, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (only.length && !only.includes(e.name)) continue;
    try {
      const manifest = JSON.parse(await readFile(path.join(root, e.name, 'manifest.json'), 'utf8'));
      out.push({ dir: path.join(root, e.name), name: e.name, manifest });
    } catch { /* not a plugin */ }
  }
  return out;
}

async function build({ dir, name, manifest }) {
  const dist = path.join(dir, 'dist');
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  const entry = manifest.entry || 'src/index.js';
  // Every declared `entry` is a separate bundle root: the main entry runs in the plugin's
  // background frame and each opener runs in its own viewer frame, so they are different
  // documents and a shared bundle would load the wrong half in each.
  const roots = new Set([entry]);
  for (const c of Object.values(manifest.contributes || {})) if (c.entry) roots.add(c.entry);

  const out = await Bun.build({
    entrypoints: [...roots].map((r) => path.join(dir, r)),
    // `trove` is injected into the frame as a global by the host, not resolved from a
    // package — see plugin-sdk/src/browser.js, which the host inlines into the srcdoc.
    external: ['trove'],
    target: 'browser',
    minify: false, // a plugin is reviewed before it is installed; readable is worth more
    format: 'esm',
  });
  if (!out.success) {
    console.error(`build failed (${name}):\n` + out.logs.map(String).join('\n'));
    process.exit(1);
  }

  const files = { 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)) };
  const built = new Map();
  for (const artifact of out.outputs) {
    built.set(path.basename(artifact.path), new Uint8Array(await artifact.arrayBuffer()));
  }
  // Bundled artifacts land under the entry path the manifest names, so the manifest a
  // reviewer reads and the file the host loads are the same string.
  for (const r of roots) {
    const bytes = built.get(path.basename(r));
    if (!bytes) { console.error(`build failed (${name}): no output for ${r}`); process.exit(1); }
    files[r] = bytes;
  }
  // Anything under assets/ ships as a package RESOURCE — the frame reads it through
  // `ctx.resources`, as opaque bytes, never as a host URL.
  await addAssets(files, dir, 'assets');

  const zip = zipSync(files);
  const outPath = path.join(dist, `${name}-${manifest.version}.zip`);
  await writeFile(outPath, zip);
  console.log(`built ${path.relative(process.cwd(), outPath)} (${zip.length.toLocaleString()} bytes, ${Object.keys(files).length} entries)`);
}

async function addAssets(files, dir, rel) {
  let entries;
  try {
    entries = await readdir(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return; // a plugin with no assets is the common case
  }
  for (const e of entries) {
    const at = `${rel}/${e.name}`;
    if (e.isDirectory()) await addAssets(files, dir, at);
    else files[at] = new Uint8Array(await readFile(path.join(dir, at)));
  }
}

const found = await plugins();
if (!found.length) {
  console.error(only.length ? `No plugin called ${only.join(', ')}` : 'No plugins found');
  process.exit(1);
}
for (const p of found) await build(p);
