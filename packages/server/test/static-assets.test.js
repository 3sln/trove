// Serving the built web app: what gets cached, and what a miss answers with.
//
// Both of these were wrong in a way that only showed up after a deploy, which is the
// worst time to find out. The responses carried no Cache-Control at all, so every
// content-addressed asset was refetched on every load and the hashing bought nothing;
// and a miss under /assets/ was answered with index.html at status 200, which the
// service worker then cached under a .js URL and served forever.

import { test, expect } from 'bun:test';
import { createStaticAssets, cacheControlFor, shouldFallBack, etagFor } from '../src/adapters/staticAssets.js';

const DIR = '/app/dist';

/** A filesystem that is just a map. `open` returns the body, as the real readers do. */
function fakeRead(files) {
  return async (filePath) => {
    const body = files[filePath];
    if (body === undefined) return null;
    return { size: body.length, mtime: 1_700_000_000_000, open: () => body };
  };
}

const FILES = {
  '/app/dist/index.html': '<!doctype html><title>Trove</title>',
  '/app/dist/assets/main-abc123.js': 'export const a = 1;',
  '/app/dist/assets/styles-def456.css': ':root{}',
  '/app/dist/sw.js': 'self.addEventListener("fetch", () => {});',
  '/app/dist/sql-wasm.wasm': 'AGFzbQ',
};

const assets = createStaticAssets({ dir: DIR, read: fakeRead(FILES) });
const get = (path, headers) => assets(new Request(`http://drive.test${path}`, { headers }));

// --- the policy ---------------------------------------------------------------

test('only the content-addressed tree is immutable', () => {
  expect(cacheControlFor('/assets/main-abc123.js')).toBe('public, max-age=31536000, immutable');
  // Everything here keeps a stable name across deploys. Claiming immutable for any of
  // them hands the browser an entry point it will never check again, which is how a
  // deploy becomes a blank page.
  expect(cacheControlFor('/')).toBe('no-cache');
  expect(cacheControlFor('/index.html')).toBe('no-cache');
  expect(cacheControlFor('/sw.js')).toBe('no-cache');
  expect(cacheControlFor('/manifest.webmanifest')).toBe('no-cache');
  expect(cacheControlFor('/sql-wasm.wasm')).toBe('no-cache');
});

test('a hashed asset is served immutable', async () => {
  const res = await get('/assets/main-abc123.js');
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(res.headers.get('content-type')).toBe('text/javascript');
});

test('the entry point is revalidated on every load', async () => {
  for (const path of ['/', '/index.html', '/sw.js']) {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  }
});

// --- the miss that used to poison caches ---------------------------------------

test('a miss under /assets/ is a 404, not the app', async () => {
  // The exact shape of the bug: a client on a previous index.html asks for a hashed
  // file that this build no longer emits. Answering with HTML at 200 makes it look like
  // a successful fetch to everything downstream.
  const res = await get('/assets/main-STALE.js');
  expect(res).toBe(null); // no asset — the server turns this into a 404
});

test('a request that looks like a file is a 404 even outside /assets/', async () => {
  expect(await get('/favicon.ico')).toBe(null);
  expect(await get('/nope.js')).toBe(null);
  expect(shouldFallBack('/robots.txt')).toBe(false);
});

test('a route with no extension still gets the app', async () => {
  // Safe because the client never puts a path in the URL — navigation.js calls pushState
  // with no URL argument, so this is for a stray refresh rather than a deep link.
  const res = await get('/settings');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/html');
  // The URL asked for decides the policy, not the file that answered it: this is
  // index.html, and index.html must never be cached hard.
  expect(res.headers.get('cache-control')).toBe('no-cache');
});

test('the API is never answered with the app', async () => {
  expect(shouldFallBack('/api/items')).toBe(false);
  expect(await get('/api/items')).toBe(null);
});

// --- validators ----------------------------------------------------------------

test('a revalidation that finds nothing changed is a 304, not a resend', async () => {
  // `no-cache` means "check before use", and a check with no validator to check against
  // is a full download. sql-wasm.wasm is 650 kB at a stable name, so this is the
  // difference between a conditional request and re-fetching it every time.
  const first = await get('/sql-wasm.wasm');
  const etag = first.headers.get('etag');
  expect(etag).toBeTruthy();

  const second = await get('/sql-wasm.wasm', { 'if-none-match': etag });
  expect(second.status).toBe(304);
  expect(second.headers.get('etag')).toBe(etag);
  expect(await second.text()).toBe('');
});

test('a stale validator is ignored', async () => {
  const res = await get('/sql-wasm.wasm', { 'if-none-match': 'W/"different"' });
  expect(res.status).toBe(200);
});

test('the validator changes when the file does', () => {
  const a = etagFor({ size: 10, mtime: 1_700_000_000_000 });
  expect(etagFor({ size: 11, mtime: 1_700_000_000_000 })).not.toBe(a);
  expect(etagFor({ size: 10, mtime: 1_700_000_000_001 })).not.toBe(a);
});

// --- containment ----------------------------------------------------------------

test('nothing outside the directory is ever even read', async () => {
  // `new URL()` resolves a literal `../` before we see it, so the vector that matters is
  // the encoded one — %2e%2e survives parsing and only becomes `..` at
  // decodeURIComponent, after the URL has stopped normalising. Asserting on the paths
  // handed to the reader rather than on the response is what makes this a test of
  // containment rather than of what happened to be missing from a fixture.
  const seen = [];
  const guarded = createStaticAssets({
    dir: '/app/dist',
    read: async (p) => { seen.push(p); return null; },
  });
  for (const path of [
    '/%2e%2e/%2e%2e/etc/passwd',
    '/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '/..%2f..%2fetc%2fpasswd',
    '/../../etc/passwd',
  ]) {
    await guarded(new Request(`http://drive.test${path}`));
  }
  expect(seen.length).toBeGreaterThan(0);
  for (const p of seen) expect(p.startsWith('/app/dist/')).toBe(true);
});

test('a path that will not decode names nothing', async () => {
  expect(await get('/%E0%A4%A')).toBe(null);
});

test('HEAD gets the headers without the body', async () => {
  const res = await assets(new Request('http://drive.test/assets/main-abc123.js', { method: 'HEAD' }));
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(await res.text()).toBe('');
});
