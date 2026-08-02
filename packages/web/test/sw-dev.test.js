// The service worker must not cache CODE on a development origin.
//
// In production this worker is doing its job: assets are fingerprinted, a build stamps a
// new SHELL name, and `activate` sweeps the old one. In `wrangler dev` the loop is
// rebuild-and-reload many times a minute, and a cached shell keeps serving the previous
// build's HTML — which points at the previous build's bundle. The symptom is the worst
// kind there is: a fix that plainly does not take, with no error anywhere, because the
// page on screen is not the page just built. It cost hours during the audiobook work.
//
// Read as source rather than executed: a service worker needs a ServiceWorkerGlobalScope,
// and what matters here is the RULE, which is legible in the text.

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

test('localhost is recognised as a development origin', () => {
  // All four, because a drive is reached at whichever the developer typed.
  for (const host of ['localhost', '127.0.0.1', '[::1]', '0.0.0.0']) {
    expect(sw).toContain(`'${host}'`);
  }
  expect(sw).toMatch(/const isDev = DEV_HOSTS\.has\(self\.location\.hostname\)/);
});

test('in dev the fetch handler declines everything except pinned file bytes', () => {
  // Declining means "return without respondWith", which lets the request go to the
  // network untouched — not a cache miss, no cache entry, nothing to go stale.
  expect(sw).toMatch(/if \(isDev && url\.pathname !== '\/api\/items\/download'\) return;/);
  // File bytes still go through the worker: the offline store is a feature under test
  // some of the time, and it is keyed by node id and etag rather than by build.
  expect(sw).toMatch(/pinnedFirst/);
});

test('nothing is precached in dev, and a stale shell is swept on activate', () => {
  // Precaching the shell in dev is precisely how a stale build survives a reload.
  expect(sw).toMatch(/isDev\s*\n?\s*\? Promise\.resolve\(\)/);
  // And a worker installed BEFORE this rule existed still has a shell cache. Activating
  // this one has to drop it, or the fix cannot take effect on the machine that needs it.
  expect(sw).toMatch(/const keep = isDev \? new Set\(\[FILES\]\) : KEEP;/);
});

test('production still caches the shell, or this is a regression rather than a fix', () => {
  // The guard must be conditional. If someone ever simplifies it into an unconditional
  // bypass, the app loses offline support entirely — which is the opposite trade.
  expect(sw).toContain('caches.open(SHELL)');
  expect(sw).toMatch(/const KEEP = new Set\(\[SHELL, API, FILES\]\)/);
});
