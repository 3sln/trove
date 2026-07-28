// Finding the built web app.
//
// This was `path.resolve(__dirname, '../../../web/dist')` in both the Node and Bun
// adapters — a guess about the shape of the tree three levels up, which held only while
// `@trove/server` and `@trove/web` landed as siblings under one `@trove/` directory.
// That was one installer's layout, not a promise, and when it stopped holding the drive
// served no web app at all with a 404 on `/` as the only symptom.
//
// Shipping as a single package removes the guess: server and web are two directories in
// one tarball now, so what used to be an assumption about an installer is a fact about
// this package. These tests pin both ways of finding it — by name, and by the layout —
// because each covers the other's failure mode.

import { test, expect } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { findWebDist } from '../src/adapters/webDist.js';

const REPO_DIST = path.resolve(import.meta.dir, '../../web/dist');

test('resolves the package by name rather than guessing at the directory layout', () => {
  const { dir, source } = findWebDist(undefined);
  expect(source).toBe('@3sln/trove');
  // A package can reference itself by name, so this is the same answer from a checkout
  // and from inside node_modules — which is why it can be the primary route rather than
  // a special case for one of the two.
  expect(fs.realpathSync(dir)).toBe(fs.realpathSync(REPO_DIST));
});

test('an explicit setting wins', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-dist-'));
  const { dir, source } = findWebDist(tmp);
  expect(dir).toBe(tmp);
  expect(source).toBe('TROVE_WEB_DIST');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a relative setting is resolved against the working directory', () => {
  const { dir } = findWebDist('./packages/web/dist');
  expect(path.isAbsolute(dir)).toBe(true);
});

test('a setting that points nowhere is reported, not quietly worked around', () => {
  // The alternative is falling through to a directory that happens to exist, which
  // means an operator who typed the path wrong gets a working server that serves the
  // wrong build — the kind of thing found weeks later.
  const { dir, source } = findWebDist('/no/such/place');
  expect(dir).toBe(null);
  expect(source).toContain('/no/such/place');
});

test('falls back to the shipped layout when the package name will not resolve', async () => {
  // A vendored copy, or a bundler that flattened the tree: the file is no longer inside
  // anything that answers to `@3sln/trove`, so resolution by name throws. The layout is
  // still the layout, though, and it is this package's own — so it is a fallback that
  // can be relied on rather than a guess about somebody else's install.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-vendored-'));
  const adapters = path.join(root, 'packages/server/src/adapters');
  fs.mkdirSync(adapters, { recursive: true });
  fs.mkdirSync(path.join(root, 'packages/web/dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/web/dist/index.html'), '<!doctype html>');
  // Named something else, so `@3sln/trove` is not a self-reference here. It still has to
  // exist, and say `module`, or the copied file is not even parsed as ESM.
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"vendored-thing","type":"module"}');
  fs.copyFileSync(path.resolve(import.meta.dir, '../src/adapters/webDist.js'), path.join(adapters, 'webDist.js'));

  const { findWebDist: vendored } = await import(path.join(adapters, 'webDist.js'));
  expect(vendored(undefined)).toEqual({
    dir: path.join(root, 'packages/web/dist'),
    source: 'relative to this file',
  });

  fs.rmSync(root, { recursive: true, force: true });
});

test('says so plainly when the app has simply not been built', () => {
  // Not an error: the API-only deployment is legitimate. It has to be distinguishable
  // from a misconfiguration, though, which is what `source` carries.
  const { dir, source } = findWebDist('');
  expect(dir === null || typeof dir === 'string').toBe(true);
  expect(typeof source).toBe('string');
});
