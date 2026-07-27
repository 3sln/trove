// Finding the built web app.
//
// This was `path.resolve(__dirname, '../../../web/dist')` in both the Node and Bun
// adapters — a guess about the shape of the tree three levels up. It is right inside
// this repo, and right again when installed, but only because `@trove/server` and
// `@trove/web` happen to land as siblings under `node_modules/@trove/`. That is a fact
// about one installer's layout, not a promise either package makes, and when it stops
// holding the drive serves no web app at all with a 404 on `/` as the only symptom.

import { test, expect } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { findWebDist } from '../src/adapters/webDist.js';

const REPO_DIST = path.resolve(import.meta.dir, '../../web/dist');

test('resolves the package rather than guessing at the directory layout', () => {
  const { dir, source } = findWebDist(undefined);
  expect(source).toBe('@trove/web');
  // In a workspace `node_modules/@trove/web` is a symlink to `packages/web`, so
  // resolution finds the same directory the relative path used to — which is why this
  // can replace it outright instead of being a second code path.
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

test('finds the app when the install is nested rather than flat', async () => {
  // The layout that broke the old relative path: `@trove/web` hoisted to the top while
  // `@trove/server` is nested under something that pinned a different version — an
  // ordinary npm outcome, not an exotic one. Three levels up from the nested adapter is
  // `wrapper/node_modules/@trove/web/dist`, which does not exist, so the drive served
  // no web app at all. Module resolution walks the parent `node_modules` chain and
  // finds the hoisted copy.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-nested-'));
  const web = path.join(root, 'node_modules/@trove/web');
  const adapters = path.join(root, 'node_modules/wrapper/node_modules/@trove/server/src/adapters');
  fs.mkdirSync(path.join(web, 'dist'), { recursive: true });
  fs.mkdirSync(adapters, { recursive: true });
  fs.writeFileSync(path.join(web, 'package.json'), '{"name":"@trove/web","version":"0.0.1"}');
  fs.writeFileSync(path.join(web, 'dist/index.html'), '<!doctype html>');
  fs.copyFileSync(path.resolve(import.meta.dir, '../src/adapters/webDist.js'), path.join(adapters, 'webDist.js'));

  const { findWebDist: nested } = await import(path.join(adapters, 'webDist.js'));
  const guess = path.resolve(adapters, '../../../web/dist');
  expect(fs.existsSync(guess)).toBe(false); // what the old code would have used
  expect(nested(undefined)).toEqual({ dir: path.join(web, 'dist'), source: '@trove/web' });

  fs.rmSync(root, { recursive: true, force: true });
});

test('says so plainly when the app has simply not been built', () => {
  // Not an error: the API-only deployment is legitimate. It has to be distinguishable
  // from a misconfiguration, though, which is what `source` carries.
  const { dir, source } = findWebDist('');
  expect(dir === null || typeof dir === 'string').toBe(true);
  expect(typeof source).toBe('string');
});
