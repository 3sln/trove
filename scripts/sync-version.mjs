#!/usr/bin/env node
//
// One version number, written in two places because npm requires it.
//
// @3sln/trove and @3sln/create-trove are released together and carry the same version:
// the scaffolder pins the exact drive it shipped alongside by reading its OWN version,
// which is only true while the two agree. npm has no way to share a version between
// manifests — every package.json must carry its own — so the root is the source of
// truth and this copies it down.
//
// Copying it BY HAND is the thing this exists to stop. That is a step someone does four
// times and then forgets on the fifth, at which point the scaffolder starts pinning a
// drive that was never published. So:
//
//   npm version patch          runs this automatically (the `version` lifecycle script)
//   npm run sync-version       does it on demand, after a hand-edit
//   npm run sync-version -- --check   fails instead of writing, which is what CI wants
//
// A regex rather than JSON.parse/stringify: this rewrites one field and leaves every
// byte of formatting, key order and comment-ish `//`-prefixed key alone.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'package.json');
const MIRRORS = [path.join(root, 'packages/create-trove/package.json')];

const check = process.argv.includes('--check');

const { version, name: sourceName } = JSON.parse(await readFile(SOURCE, 'utf8'));
if (!version) {
  console.error('The root package.json has no version.');
  process.exit(1);
}

let drifted = 0;
let written = 0;

for (const file of MIRRORS) {
  const raw = await readFile(file, 'utf8');
  const found = raw.match(/"version":\s*"([^"]*)"/);
  if (!found) {
    console.error(`${path.relative(root, file)} has no version field.`);
    process.exit(1);
  }
  if (found[1] === version) continue;

  drifted++;
  const where = path.relative(root, file);
  if (check) {
    console.error(`::error::${where} is ${found[1]}, but ${sourceName} is ${version}.`);
    continue;
  }
  await writeFile(file, raw.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`));
  console.log(`${where}: ${found[1]} -> ${version}`);
  written++;
}

if (check && drifted) {
  console.error('\nThe two packages are released together and must carry the same version.');
  console.error('Fix it with:  npm run sync-version');
  process.exit(1);
}

console.log(check
  ? `Both packages are at ${version}.`
  : written ? `Synced ${written} manifest(s) to ${version}.` : `Already at ${version}.`);
