// Serving the built web app.
//
// This was copied into the Node and Bun adapters, and had already drifted — one of them
// had a content-type fallback the other did not. What differs between the two runtimes
// is how you read a file; everything else (where to look, what to refuse, what to say
// about caching) is one policy, so it lives here and each adapter passes in its reader.
//
// Three things this gets right that the copies did not:
//
//   A miss under /assets/ is a 404, not the SPA fallback. The fallback answered EVERY
//   non-/api miss with index.html at status 200 — including a request for a hashed
//   asset. After a deploy the old hashed names are gone, so a client still running the
//   previous index.html asked for `/assets/main-OLD.js` and got HTML with
//   `content-type: text/html`. The module fails to load, and because the service worker
//   caches anything that came back 200, the HTML was stored under the JS URL and served
//   from cache forever after. A 404 is a miss the browser and the worker both
//   understand.
//
//   Cache-Control is claimed where it is true and nowhere else. Everything under
//   /assets/ is content-addressed — the filename changes when the bytes do — so it can
//   be kept for a year and never revalidated. Everything else keeps a stable name and
//   must be revalidated on every load. Marking the second group immutable is what turns
//   a deploy into a blank page; leaving the first group unmarked is what makes the
//   hashing pointless, which is what was happening: the responses carried no
//   Cache-Control at all.
//
//   There are validators. `no-cache` does not mean "do not cache", it means "revalidate
//   before use" — but a revalidation with nothing to revalidate AGAINST is just a fresh
//   download. sql-wasm.wasm is 650 kB and sits at a stable name, so without an ETag it
//   came down in full every time a plugin touched client storage.

import path from 'node:path';
// The policy lives in its own module because index.js needs it too and has to stay
// loadable on Workers, where `node:path` is not there to be imported.
import { IMMUTABLE_PREFIX, cacheControlFor } from '../cachePolicy.js';

export { IMMUTABLE_PREFIX, cacheControlFor };

export const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
  '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
};

/**
 * Should a miss here fall back to the SPA entry point?
 *
 * The client never puts a path in the URL — `navigation.js` calls pushState with no URL
 * argument, so the whole app lives at `/`. The fallback is therefore for robustness
 * (a refresh somewhere unexpected), never for deep links, which is what makes it safe
 * to refuse anything that looks like a file rather than a route.
 *
 * @param {string} pathname
 */
export function shouldFallBack(pathname) {
  if (pathname.startsWith('/api/')) return false;
  // Content-addressed: a miss is a stale reference to a build that no longer exists.
  // Answering it with HTML is what poisons a service worker cache.
  if (pathname.startsWith(IMMUTABLE_PREFIX)) return false;
  // Anything with an extension is asking for a file, not a view.
  if (path.extname(pathname)) return false;
  return true;
}

/** A weak validator from what a stat already tells us — no hashing, no read. */
export const etagFor = ({ size, mtime }) => `W/"${size.toString(16)}-${Math.floor(mtime).toString(16)}"`;

/**
 * Build the `assets` fetcher the server takes.
 *
 * @param {object} opts
 * @param {string} opts.dir the built web app
 * @param {(filePath: string) => Promise<{size: number, mtime: number, type?: string, open: () => any}|null>} opts.read
 *   runtime-specific: resolve to null when the path is not a readable file. `open` is
 *   separate from the stat so a 304 or a HEAD does not open a handle it will not read.
 */
export function createStaticAssets({ dir, read }) {
  return async function staticAssets(req) {
    const url = new URL(req.url);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return null; // a bad escape names nothing
    }

    const served = await serve(pathname === '/' ? '/index.html' : pathname);
    if (served) return served;

    if ((req.method === 'GET' || req.method === 'HEAD') && shouldFallBack(pathname)) {
      return serve('/index.html', { as: pathname });
    }
    return null;

    async function serve(rel, { as = rel } = {}) {
      const filePath = path.join(dir, path.normalize(rel));
      // path.normalize collapses `..`, but only a prefix check proves the result is
      // still inside the directory we meant.
      if (filePath !== dir && !filePath.startsWith(dir + path.sep)) return null;

      const file = await read(filePath);
      if (!file) return null;

      const type = MIME[path.extname(filePath)] || file.type || 'application/octet-stream';
      const etag = etagFor(file);
      const headers = {
        'content-type': type,
        // The URL the client asked for decides the policy, not the file that answered:
        // index.html served as an SPA fallback must still be revalidated.
        'cache-control': cacheControlFor(as),
        etag,
      };

      // A validator is only worth attaching if we also honour it — otherwise every
      // revalidation is a full download of something the client already has.
      if (req.headers.get('if-none-match') === etag) {
        return new Response(null, { status: 304, headers });
      }
      return new Response(req.method === 'HEAD' ? null : file.open(), { headers });
    }
  };
}
