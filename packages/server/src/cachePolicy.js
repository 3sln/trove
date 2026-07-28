// What may be cached, and for how long.
//
// Its own module, with no imports at all, because it is needed in two places that
// cannot import each other: the Node/Bun static file server (which needs `node:path`
// and so cannot load on Workers) and the runtime-agnostic request path in index.js
// (which must load on Workers, where the assets come from a binding instead).
//
// The rule the build enforces and this describes: everything under /assets/ is
// content-addressed, so the filename changes whenever the bytes do and the URL can be
// kept forever. Everything else — index.html, sw.js, the manifest, the icon — keeps a
// stable name and must be revalidated on every load.
//
// Getting this backwards is what turns a deploy into a blank page. Marking a mutable,
// stable-named URL `immutable` hands a browser a cached entry point it will not check
// again, so it goes on importing hashed modules from a build that no longer exists.
// Leaving the content-addressed tree unmarked is the cheaper mistake and was the one in
// force: the responses carried no Cache-Control at all, so the hashing bought nothing.

/** Kept in step with the `naming` patterns in packages/web/build.mjs. */
export const IMMUTABLE_PREFIX = '/assets/';

/** A year, and never revalidated — safe only because the name changes with the bytes. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Cacheable, but check with the server before every use. */
export const REVALIDATE = 'no-cache';

/**
 * @param {string} pathname request path, already decoded
 * @returns {string} a Cache-Control value
 */
export function cacheControlFor(pathname) {
  return pathname.startsWith(IMMUTABLE_PREFIX) ? IMMUTABLE : REVALIDATE;
}
