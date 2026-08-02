// The package the server would actually be asked to install.
//
// A plugin's manifest is validated by the SERVER, independently, on upload — so the way a
// plugin breaks is not a failing import, it is a install-time refusal that nobody sees
// until they try it. This runs the real parser over a real zip built from this directory,
// which makes "does it still install" a question the test suite answers.
//
// Zipped from the source tree rather than from `dist/`: the manifest is what is being
// checked, and requiring a build step first would mean the check silently stops running
// whenever the build has not been run.

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { parsePluginPackage, ALL_CAPABILITIES } from '@3sln/trove/core/plugins/package.js';

const dir = new URL('..', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

/** The manifest plus every entry it names — which is what the server checks for. */
function pack() {
  const files = { 'manifest.json': strToU8(JSON.stringify(manifest)) };
  const entries = new Set([manifest.entry]);
  for (const c of Object.values(manifest.contributes || {})) if (c.entry) entries.add(c.entry);
  for (const e of entries) files[e] = new Uint8Array(readFileSync(join(dir, e)));
  return zipSync(files);
}

test('the package parses the way the server parses it', async () => {
  const pkg = await parsePluginPackage(pack());
  expect(pkg.manifest.name).toBe('audiobook');
  expect(pkg.manifest.domain).toBe('3sln.com');
  // The opener is what makes this plugin do anything at all: a contribution is DECLARED in
  // the manifest and registered by the host before any plugin code runs, so a typo here is
  // a plugin that installs and opens nothing.
  expect(pkg.contributions.map((c) => `${c.name}:${c.type}`)).toEqual(['player:opener']);
});

test('it asks for exactly the capabilities it can justify', async () => {
  const pkg = await parsePluginPackage(pack());
  expect(pkg.capabilities.sort()).toEqual(['dock', 'files', 'media', 'ui']);
  // Not `network` — it talks to nothing but the drive — and not `storage`, because it keeps
  // no database of its own. A capability nobody can justify in one line is one the review
  // dialog should not be asking someone to grant.
  expect(pkg.capabilities).not.toContain('network');
  expect(pkg.capabilities).not.toContain('storage');
  for (const c of pkg.capabilities) expect(ALL_CAPABILITIES).toContain(c);
});

test('every entry the manifest names is really in the package', async () => {
  // The failure this catches: renaming a source file and not the manifest. The plugin
  // installs, the host asks for an entry that is not there, and the viewer is blank.
  const files = pack();
  const pkg = await parsePluginPackage(files);
  const named = [manifest.entry, ...Object.values(manifest.contributes).map((c) => c.entry)];
  for (const entry of named.filter(Boolean)) expect(pkg.files[entry]).toBeTruthy();
});

test('the opener matches the formats the README claims it does', async () => {
  const opener = Object.values(manifest.contributes).find((c) => c.type === 'opener');
  // M4B and LPF are the two the player has real support for; m4a/aac degrade to a
  // one-chapter book, which is the honest answer rather than a failure.
  expect(opener.match.ext).toContain('.m4b');
  expect(opener.match.ext).toContain('.lpf');
  expect(opener.match.ext).toContain('.m4a');
  // `.aax`/`.aaxc` are DRM-encrypted rather than merely wrapped, and are deliberately NOT
  // claimed — see the README. Claiming them would offer to open a file this cannot play.
  expect(opener.match.ext).not.toContain('.aax');
  expect(opener.match.ext).not.toContain('.aaxc');
  // `dock: true`, which is what lets the book keep playing while the drive is browsed.
  expect(opener.dock).toBe(true);
});
