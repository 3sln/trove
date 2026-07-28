// A tiny Web-standard router: register (method, pattern) → handler, match an
// incoming Request, and produce a Response. Patterns use ':param' segments
// (e.g. '/uploads/:id/parts/:n'). Handlers receive { req, params, query, url }
// and return a Response (or a plain object → JSON). All errors funnel through
// one place so a TroveError becomes the right status + JSON body, and anything
// unexpected becomes a clean 500 without leaking internals.

import { TroveError, wrapError, ErrorCode, publicOrigin } from '@3sln/trove/core';
import { leaseScope } from './scope.js';

// Methods that change state. A GET is safe by definition, so it isn't checked.
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * Refuse a state-changing request that another site made using the user's session.
 *
 * The CORS allowlist governs whether an attacker can READ the reply, and it only stops
 * requests that need a preflight. A POST with `content-type: text/plain` is a CORS
 * *simple request*: no preflight is sent, the allowlist is never consulted, and the
 * write happens. The reply being unreadable is no comfort when the call was
 * `delete_file`. Both the JSON API and the MCP endpoint were reachable that way, and
 * the zero-config deployment needs no credential at all — the attacker's own browser
 * is the credential.
 *
 * Browsers send `Sec-Fetch-Site` on every request and `Origin` on every state-changing
 * one, so a cross-site call identifies itself. Non-browser clients (curl, an agent, a
 * script) send neither and are unaffected — they carry no ambient credential, which is
 * the entire basis of the attack. A bearer token is likewise not ambient, but it is not
 * special-cased: a request that presents one is same-origin or scripted anyway.
 *
 * @returns {Response|null} a 403 to return instead of handling, or null to proceed
 */
export function crossSiteRefusal(req, config = {}) {
  if (!UNSAFE_METHODS.has(req.method)) return null;
  const site = req.headers.get('sec-fetch-site');
  const origin = req.headers.get('origin');
  if (!site && !origin) return null; // not a browser

  // An operator who opted into CORS for an origin meant it: that site may call us.
  const allowed = corsOriginFor(config?.corsOrigin, origin);
  if (allowed === '*' || (allowed && allowed === origin)) return null;

  if (site) {
    if (site === 'same-origin' || site === 'none') return null;
  } else if (origin === publicOrigin(req, config) || origin === new URL(req.url).origin) {
    return null;
  }
  return json({
    error: {
      code: 'forbidden',
      message: 'Cross-site requests may not change this drive. If this is intentional, set TROVE_CORS_ORIGIN.',
      retryable: false,
    },
  }, 403);
}

export class Router {
  constructor() {
    this.routes = [];
  }

  /**
   * @param {string} method
   * @param {string} pattern
   * @param {string[]|Function} depsOrHandler  the resources this route needs, by
   *   name — or the handler, for a route that needs none.
   * @param {Function} [maybeHandler]
   *
   * Declaring dependencies is the point. Every handler used to receive one
   * object carrying the whole server: vfs, collections, kv, sqlite, plugins,
   * tasks, issues, sidecar, notifications, identity, mcp. That is a service
   * locator — nothing recorded what a route used, so nothing stopped it reaching
   * for more, and "what does this endpoint touch" could only be answered by
   * reading it. Named here, the answer is in the route table, and a route that
   * did not ask for `plugins` does not get `plugins`.
   */
  add(method, pattern, depsOrHandler, maybeHandler) {
    const handler = maybeHandler ?? depsOrHandler;
    const deps = maybeHandler ? depsOrHandler : [];
    const segs = pattern.split('/').filter(Boolean);
    this.routes.push({ method, segs, handler, deps });
    return this;
  }
  get(p, d, h) { return this.add('GET', p, d, h); }
  post(p, d, h) { return this.add('POST', p, d, h); }
  put(p, d, h) { return this.add('PUT', p, d, h); }
  delete(p, d, h) { return this.add('DELETE', p, d, h); }

  #match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segs.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < route.segs.length; i++) {
        const s = route.segs[i];
        // A malformed percent-escape (`/api/uploads/%ZZ/status`) makes
        // decodeURIComponent throw a URIError — and #match runs OUTSIDE the try below,
        // so it escaped the error funnel entirely and rejected the whole handle() call.
        // A bad escape names nothing, which is a 404, not a 500.
        if (s.startsWith(':')) {
          try {
            params[s.slice(1)] = decodeURIComponent(parts[i]);
          } catch {
            ok = false;
            break;
          }
        }
        else if (s !== parts[i]) { ok = false; break; }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  /**
   * @param {Request} req
   * @param {object} [ctx] extra context merged into the handler arg (e.g. { vfs })
   */
  async handle(req, ctx = {}) {
    const url = new URL(req.url);
    // Cross-origin sharing is OFF by default (the app is same-origin); an operator
    // opts in with TROVE_CORS_ORIGIN ('*' or a specific origin) → config.corsOrigin.
    const origin = corsOriginFor(ctx.config?.corsOrigin, req.headers.get('origin'));
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), origin);

    const refused = crossSiteRefusal(req, ctx.config);
    if (refused) return cors(refused, origin);

    const found = this.#match(req.method, url.pathname);
    if (!found) return cors(json({ error: { code: 'not_found', message: 'No such route' } }, 404), origin);

    const query = Object.fromEntries(url.searchParams);
    // Exactly what the route declared, leased for exactly the request. Released
    // in `finally`, so a handler that throws still gives its resources back.
    let lease = null;
    // Handles obtained during the request, released with it. `access` is how a
    // handler asks for an AUTHORIZED view of a node, collection or upload: the
    // grant is carried by the object it hands back, so there is no unrestricted
    // service and no raw id left over to use with one.
    const scope = leaseScope(ctx.container, ctx.principal);
    const access = scope.access;
    try {
      lease = ctx.container ? await ctx.container.lease(found.route.deps) : null;
      const result = await found.route.handler({
        req, params: found.params, query, url, access, ...ctx, ...(lease?.resources || {}),
      });
      const res = result instanceof Response ? result : json(result ?? { ok: true });
      return cors(res, origin);
    } catch (raw) {
      const err = raw instanceof TroveError ? raw : wrapError(raw);
      if (err.code === ErrorCode.INTERNAL) console.error('Unhandled:', err.cause || err);
      return cors(json(err.toJSON(), err.status), origin);
    } finally {
      await scope.release();
      await lease?.release();
    }
  }
}

// Resolve the Access-Control-Allow-Origin value: null (no CORS) unless configured.
// '*' echoes '*'; a configured origin is echoed only when the request matches it
// (so credentials-mode requests get a specific origin, not a wildcard).
function corsOriginFor(configured, reqOrigin) {
  if (!configured) return null;
  if (configured === '*') return '*';
  const allowed = String(configured).split(',').map((s) => s.trim()).filter(Boolean);
  return reqOrigin && allowed.includes(reqOrigin) ? reqOrigin : null;
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function cors(res, origin = null) {
  const out = writable(res);
  // Never let a browser sniff an API response into a different content type.
  out.headers.set('x-content-type-options', 'nosniff');
  if (origin) {
    out.headers.set('access-control-allow-origin', origin);
    if (origin !== '*') out.headers.set('vary', 'Origin');
    out.headers.set('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    out.headers.set('access-control-allow-headers', 'content-type, authorization, x-trove-indexer');
    out.headers.set('access-control-expose-headers', 'content-range, accept-ranges, etag, content-length, content-disposition');
  }
  return out;
}

// `Response.redirect()` produces a response whose headers guard is IMMUTABLE — setting
// anything on it throws `TypeError: immutable`. Every response funnels through cors(),
// so on a runtime that enforces the guard (Node, Workers; Bun happens not to) a single
// presigned-download redirect became a 500 caught by the same try/catch that logs it as
// an internal error. Copy into a plain Response, whose headers are always writable.
function writable(res) {
  try {
    res.headers.set('x-content-type-options', 'nosniff');
    return res;
  } catch {
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: new Headers(res.headers) });
  }
}

/**
 * Parse a Range header (single range only).
 *
 * `bytes=500-999` → `{start, end}`. `bytes=-500` is the SUFFIX form and means the last
 * 500 bytes, not the first 501 — it resolves against the object's real size, so it comes
 * back as `{suffix}` for the storage layer to apply.
 *
 * @returns {{start:number, end?:number}|{suffix:number}|null}
 */
export function parseRange(header) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  if (m[1] === '') {
    if (m[2] === '') return null; // "bytes=-" is neither form
    const suffix = parseInt(m[2], 10);
    return Number.isNaN(suffix) ? null : { suffix };
  }
  const start = parseInt(m[1], 10);
  const end = m[2] === '' ? undefined : parseInt(m[2], 10);
  if (Number.isNaN(start)) return null;
  return { start, end };
}
