// A tiny Web-standard router: register (method, pattern) → handler, match an
// incoming Request, and produce a Response. Patterns use ':param' segments
// (e.g. '/uploads/:id/parts/:n'). Handlers receive { req, params, query, url }
// and return a Response (or a plain object → JSON). All errors funnel through
// one place so a TroveError becomes the right status + JSON body, and anything
// unexpected becomes a clean 500 without leaking internals.

import { TroveError, wrapError } from '@trove/core';

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const segs = pattern.split('/').filter(Boolean);
    this.routes.push({ method, segs, handler });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  #match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segs.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < route.segs.length; i++) {
        const s = route.segs[i];
        if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(parts[i]);
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

    const found = this.#match(req.method, url.pathname);
    if (!found) return cors(json({ error: { code: 'not_found', message: 'No such route' } }, 404), origin);

    const query = Object.fromEntries(url.searchParams);
    try {
      const result = await found.route.handler({ req, params: found.params, query, url, ...ctx });
      const res = result instanceof Response ? result : json(result ?? { ok: true });
      return cors(res, origin);
    } catch (raw) {
      const err = raw instanceof TroveError ? raw : wrapError(raw);
      if (err.code === 'internal') console.error('Unhandled:', err.cause || err);
      return cors(json(err.toJSON(), err.status), origin);
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
  // Never let a browser sniff an API response into a different content type.
  res.headers.set('x-content-type-options', 'nosniff');
  if (origin) {
    res.headers.set('access-control-allow-origin', origin);
    if (origin !== '*') res.headers.set('vary', 'Origin');
    res.headers.set('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.headers.set('access-control-allow-headers', 'content-type, authorization, x-trove-indexer');
    res.headers.set('access-control-expose-headers', 'content-range, accept-ranges, etag, content-length, content-disposition');
  }
  return res;
}

/** Parse a Range header into { start, end? } (single range only). */
export function parseRange(header) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const start = m[1] === '' ? 0 : parseInt(m[1], 10);
  const end = m[2] === '' ? undefined : parseInt(m[2], 10);
  if (Number.isNaN(start)) return null;
  return { start, end };
}
