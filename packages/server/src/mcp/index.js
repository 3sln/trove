// The MCP endpoint: one URL, JSON-RPC over HTTP, guarded by the drive's own identity.
//
// This is the "Streamable HTTP" transport. Trove implements the half of it that matters
// for a server with no server-initiated messages: POST carries a request and gets a
// single JSON response back. The GET-for-SSE half exists in the spec so a server can
// push notifications, and Trove has none to push — so it says 405 rather than holding a
// stream open that will never carry anything. A client that needs streaming will fall
// back to plain POST, which is what it would end up using anyway.
//
// Authentication reuses the drive's IdentityProvider verbatim. That is the point of the
// exercise: an agent presents the same JWT the browser does, subject to the same
// verification and the same collection permissions, so granting an agent access is not a
// second access-control system to keep in sync with the first.

import { TroveError } from '@trove/core';
import { McpServer, rpcError, JSONRPC_ERRORS } from './protocol.js';
import { registerTroveTools } from './tools.js';
import {
  challengeHeaders, protectedResourceMetadata, resourceUri, metadataUrl,
  McpConfigStore, mcpConfigFromEnv,
} from './auth.js';

const MAX_BODY_BYTES = 1024 * 1024;

export { McpServer, McpConfigStore, mcpConfigFromEnv, protectedResourceMetadata, challengeHeaders, resourceUri, metadataUrl };

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
 */
export function createMcpHandler({ vfs, collections, identity, config = {}, kv, version } = {}) {
  const defaults = { path: '/mcp', enabled: true, ...mcpConfigFromEnv(config.env || {}), ...(config.mcp || {}) };
  if (defaults.enabled === false) return null;
  const store = new McpConfigStore({ kv, defaults });
  const server = createMcpServer({ version });

  /** The 401 an agent uses to discover where to sign in. */
  const unauthorized = async (req, description) => {
    const cfg = await store.get();
    return jsonResponse(
      // A JSON-RPC error body as well as the header, because a client that reads the
      // body before the status still gets told what happened.
      rpcError(null, JSONRPC_ERRORS.INVALID_REQUEST, description || 'Authentication required'),
      401,
      challengeHeaders(req, cfg, { description }),
    );
  };

  async function handle(req, url) {
    const cfg = await store.get();
    const path = cfg.path || '/mcp';

    // --- discovery: RFC 9728 --------------------------------------------------
    // Served whether or not auth is on, and always unauthenticated — a document whose
    // entire job is to tell you how to authenticate cannot itself require a token.
    if (url.pathname === '/.well-known/oauth-protected-resource'
      || url.pathname === `/.well-known/oauth-protected-resource${path}`) {
      return jsonResponse(protectedResourceMetadata(req, cfg), 200, {
        // Public and stable; agents fetch it on every cold connection.
        'cache-control': 'public, max-age=3600',
        'access-control-allow-origin': '*',
      });
    }

    if (url.pathname !== path) return null;

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': req.headers.get('origin') || '*',
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

    const ctx = { vfs, collections, principal, config };

    // A batch is an array. Notifications inside it contribute nothing to the reply, and
    // a batch of only notifications gets 202 with no body at all.
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
  }

  return { handle, server, store, path: () => (store._cache?.path || defaults.path || '/mcp'), authRequired: (cfg) => authRequired(cfg, identity) };
}
