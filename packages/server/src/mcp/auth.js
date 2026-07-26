// MCP's slice of the drive's auth discovery.
//
// The authorization server lives in core (identity/discovery.js) because it is a
// property of the DEPLOYMENT, not of this endpoint: an unauthenticated call to
// /api/items and an unauthenticated call to /mcp have the same answer, and a client
// pointed at either should be sent to the same place. Two settings for one fact is how
// they end up disagreeing.
//
// What IS specific to MCP is the resource identifier — the canonical URI naming this
// endpoint, which an agent puts in the RFC 8707 `resource` parameter and which the
// token's audience should match. That is about which resource, not about which
// authorization server, so it stays here.

import { publicOrigin } from '@trove/core';

/** Read MCP settings out of the process environment. */
export function mcpConfigFromEnv(env = {}) {
  const cfg = {};
  if (env.TROVE_MCP != null) cfg.enabled = !/^(0|off|false|no)$/i.test(String(env.TROVE_MCP));
  if (env.TROVE_MCP_PATH) cfg.path = env.TROVE_MCP_PATH;
  if (env.TROVE_MCP_RESOURCE) cfg.resource = String(env.TROVE_MCP_RESOURCE).replace(/\/+$/, '');
  // Whether, not where. The drive's posture is the default — see authRequired — and this
  // exists for the deployment that wants an open web app and a locked-down agent
  // endpoint, or the reverse.
  if (env.TROVE_MCP_REQUIRE_AUTH != null) cfg.requireAuth = !/^(0|off|false|no)$/i.test(String(env.TROVE_MCP_REQUIRE_AUTH));
  return cfg;
}

/**
 * The canonical URI of this MCP endpoint.
 *
 * Derived from the request when not configured, so a self-hoster doesn't have to tell
 * the server its own address. Configured explicitly when the drive sits behind a proxy
 * that rewrites the Host in a way the forwarded headers don't capture, where guessing
 * would produce an identifier no token will ever match.
 */
export function mcpResourceUri(req, cfg = {}, serverConfig = {}) {
  if (cfg.resource) return String(cfg.resource).replace(/\/+$/, '');
  return `${publicOrigin(req, serverConfig)}${cfg.path || '/mcp'}`;
}
