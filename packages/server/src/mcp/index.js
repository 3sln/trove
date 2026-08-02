// The MCP endpoint: one URL, JSON-RPC over HTTP, guarded by the drive's own identity.
//
// This is the "Streamable HTTP" transport. Trove implements the half of it that matters
// for a server with no server-initiated messages: POST carries a request and gets a
// single JSON response back. The GET-for-SSE half exists in the spec so a server can
// push notifications, and Trove has none to push — so it says 405 rather than holding a
// stream open that will never carry anything. A client that needs streaming falls back
// to plain POST, which is what it would end up using anyway.
//
// Authentication reuses the drive's IdentityProvider verbatim, and its authorization
// server comes from the drive's config rather than from anything MCP-specific. That is
// the point of the exercise: an agent presents the same JWT the browser does, from the
// same place, subject to the same verification and the same collection permissions. It
// is not a second access-control system to keep in sync with the first.

import { TroveError, challengeHeaders, protectedResourceMetadata } from '@3sln/trove/core';
import { McpServer, rpcError, JSONRPC_ERRORS } from './protocol.js';
import { registerTroveTools } from './tools.js';
import { mcpConfigFromEnv, mcpResourceUri } from './auth.js';
import { crossSiteRefusal, corsOriginFor } from '../router.js';
import { leaseScope } from '../scope.js';

const MAX_BODY_BYTES = 1024 * 1024;

export { McpServer, mcpConfigFromEnv, mcpResourceUri };

export function createMcpServer({ name = 'trove', version = '0.0.1' } = {}) {
  return registerTroveTools(new McpServer({ name, version }));
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body == null ? {} : { 'content-type': 'application/json' }),
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

/**
 * Does this deployment require a token for MCP?
 *
 * Default: follow the drive. A drive running open (the zero-config case, one shared
 * anonymous user) exposes MCP the same way, because demanding a token from an agent for
 * a drive that demands none from a browser protects nothing. A drive with a real
 * identity provider requires one. An operator can force either.
 */
function authRequired(cfg, identity) {
  if (cfg.requireAuth != null) return !!cfg.requireAuth;
  return !identity?.constructor?.name?.startsWith('Anonymous');
}

/**
 * Build the MCP request handler.
 *
 * Returns null when MCP is switched off, so the caller can skip the routes entirely
 * rather than serving an endpoint that 404s in a way indistinguishable from a typo.
 *
 * @param {object} deps
 * @param {object} deps.auth the drive's resolved auth discovery (see resolveAuthDiscovery)
 */
export function createMcpHandler({ vfs, collections, container, identity, config = {}, auth = {}, version, rateLimiter = null } = {}) {
  const cfg = { path: '/mcp', enabled: true, ...mcpConfigFromEnv(config.env || {}), ...(config.mcp || {}) };
  if (cfg.enabled === false) return null;
  const server = createMcpServer({ version });
  const path = cfg.path || '/mcp';

  /** The 401 an agent uses to discover where to sign in. */
  const unauthorized = (req, description) => jsonResponse(
    // A JSON-RPC error body as well as the header, because a client that reads the body
    // before the status still gets told what happened.
    rpcError(null, JSONRPC_ERRORS.INVALID_REQUEST, description || 'Authentication required'),
    401,
    challengeHeaders(mcpResourceUri(req, cfg, config), auth, { description }),
  );

  async function handle(req, url) {
    // --- discovery: RFC 9728 for THIS endpoint --------------------------------
    // The drive's own document is served by the caller at the bare well-known path;
    // this is the /mcp-suffixed one, which names the MCP endpoint as the resource.
    // Always unauthenticated — a document whose whole job is to say how to authenticate
    // cannot itself require a token.
    if (url.pathname === `/.well-known/oauth-protected-resource${path}`) {
      return jsonResponse(protectedResourceMetadata(mcpResourceUri(req, cfg, config), auth), 200, {
        'cache-control': 'public, max-age=3600',
        'access-control-allow-origin': '*',
      });
    }

    if (url.pathname !== path) return null;

    if (req.method === 'OPTIONS') {
      // Echoing the request's own Origin approves EVERY site. On the zero-config
      // deployment MCP needs no token, so that let any page the user happened to be
      // visiting call write_file and delete_file on their drive — the reply is
      // unreadable to the attacker, but the deletions still happen. Agents are not
      // browsers and do not need CORS at all, so this follows the same
      // TROVE_CORS_ORIGIN allowlist the JSON API does, and stays off by default.
      const origin = corsOriginFor(config?.corsOrigin, req.headers.get('origin'));
      if (!origin) return new Response(null, { status: 204 });
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': origin,
          ...(origin === '*' ? {} : { vary: 'Origin' }),
          'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version, mcp-session-id',
          'access-control-expose-headers': 'www-authenticate, mcp-session-id',
        },
      });
    }

    // No server-initiated messages, so no stream to open. Said plainly.
    if (req.method === 'GET') {
      return jsonResponse({ error: 'This server sends no unsolicited messages; POST JSON-RPC requests instead.' }, 405,
        { allow: 'POST, OPTIONS' });
    }
    // Sessions are not used — every request stands alone — so there is nothing to end.
    if (req.method === 'DELETE') return new Response(null, { status: 204 });
    if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, { allow: 'POST, OPTIONS' });

    // The OPTIONS allowlist above only governs requests a browser preflights. A
    // cross-site POST with `content-type: text/plain` is a CORS simple request — no
    // preflight, so nothing consulted that allowlist, and `delete_file` ran. Agents are
    // not browsers and send none of these headers, so this costs them nothing.
    const refused = crossSiteRefusal(req, config);
    if (refused) return refused;

    // --- identity -------------------------------------------------------------
    let principal = null;
    const needsAuth = authRequired(cfg, identity);
    try {
      principal = await identity.authenticate(req);
    } catch (err) {
      // A bad token is a 401 WITH the challenge, not a bare rejection — an agent whose
      // token expired needs to be told where to get another one, which is the same
      // answer as for an agent that never had one.
      const e = err instanceof TroveError ? err : null;
      if (e && e.code === 'transient') {
        return jsonResponse(rpcError(null, JSONRPC_ERRORS.INTERNAL, e.message), 503);
      }
      return unauthorized(req, err?.message || 'The token was not accepted.');
    }
    if (needsAuth && (!principal || principal.anonymous)) {
      return unauthorized(req, 'This drive requires a bearer token.');
    }

    // --- the message ----------------------------------------------------------
    const declared = Number(req.headers.get('content-length') || 0);
    if (declared > MAX_BODY_BYTES) {
      return jsonResponse(rpcError(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Request too large'), 413);
    }
    let text;
    try {
      text = await req.text();
    } catch {
      return jsonResponse(rpcError(null, JSONRPC_ERRORS.PARSE, 'Could not read the request body'), 400);
    }
    if (text.length > MAX_BODY_BYTES) {
      return jsonResponse(rpcError(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Request too large'), 413);
    }
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return jsonResponse(rpcError(null, JSONRPC_ERRORS.PARSE, 'Body is not valid JSON'), 400);
    }

    // The same authorization the browser gets, from the same place: a tool asks for a
    // node or collection HANDLE and operates through it, so there is no MCP-shaped path
    // around the collection ACL and no unrestricted `vfs` sitting in a tool body.
    const scope = leaseScope(container, principal);
    // The limiter reaches this surface too. An agent holding somebody's token can search
    // as fast as it likes otherwise, and a search is the paid one — "exactly as privileged
    // as the person whose token it holds" has to include how much they can spend.
    const ctx = { vfs, collections, principal, config, access: scope.access, rateLimiter };

    try {
      // A batch is an array. Notifications inside it contribute nothing to the reply,
      // and a batch of only notifications gets 202 with no body at all.
      if (Array.isArray(msg)) {
        if (!msg.length) return jsonResponse(rpcError(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Empty batch'), 400);
        const replies = (await Promise.all(msg.map((m) => server.dispatch(m, ctx)))).filter(Boolean);
        return replies.length ? jsonResponse(replies) : new Response(null, { status: 202 });
      }

      const reply = await server.dispatch(msg, ctx);
      // A notification gets 202 and NO body. Returning a JSON-RPC envelope here is the
      // classic way to make a conformant client decide the server is broken.
      if (!reply) return new Response(null, { status: 202 });
      return jsonResponse(reply);
    } finally {
      await scope.release();
    }
  }

  return {
    handle,
    server,
    path,
    config: cfg,
    /** What to paste into an agent, for a given request's public origin. */
    endpoint: (req) => mcpResourceUri(req, cfg, config),
    requiresAuth: () => authRequired(cfg, identity),
  };
}
