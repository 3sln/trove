// Telling an agent how to get in.
//
// Trove doesn't run a login system — it verifies tokens somebody else issued. That is
// awkward for MCP, because an agent connecting to a server it has never seen needs to
// discover WHERE to authenticate before it can present anything. OAuth 2.0 Protected
// Resource Metadata (RFC 9728) is exactly that discovery step, and it is what the MCP
// authorization spec builds on, so this implements it rather than inventing a scheme:
//
//   1. An unauthenticated request gets 401 with
//        WWW-Authenticate: Bearer resource_metadata="https://drive/.well-known/oauth-protected-resource/mcp"
//   2. The agent fetches that document and learns which authorization server to use.
//   3. It runs the normal OAuth flow there and comes back with a bearer token, which is
//      the SAME JWT the web app presents — one identity provider, not two.
//
// Step 2 is the part a self-hoster has to fill in, because only they know which IdP they
// put in front of the drive. So the authorization server is configuration (env or, for
// an admin, a setting stored in KV), and when it is missing the 401 says so in words an
// operator can act on rather than failing silently into an unusable discovery document.

const KV_NS = 'mcp';
const KV_KEY = 'config';

/**
 * The canonical URI of this MCP resource — what an agent puts in the `resource`
 * parameter (RFC 8707) and what the token's audience should name.
 *
 * Derived from the request when not configured, because a self-hoster shouldn't have to
 * tell the server its own address. Configured explicitly when the drive sits behind a
 * proxy that rewrites the Host, where guessing would produce a resource identifier no
 * token will ever match.
 */
export function resourceUri(req, cfg = {}) {
  if (cfg.resource) return String(cfg.resource).replace(/\/+$/, '');
  const url = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto');
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host;
  return `${proto || url.protocol.replace(':', '')}://${host}${cfg.path || '/mcp'}`;
}

/**
 * Where the metadata document lives for a given resource.
 *
 * RFC 9728 inserts the well-known segment BETWEEN the host and the path rather than
 * appending it, so a resource at `https://d/mcp` is described at
 * `https://d/.well-known/oauth-protected-resource/mcp`. Appending instead is a common
 * enough mistake that clients have had to work around it; getting it right here is what
 * lets an off-the-shelf agent find the document without one.
 */
export function metadataUrl(resource) {
  const u = new URL(resource);
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.origin}/.well-known/oauth-protected-resource${path}`;
}

/** The RFC 9728 document itself. */
export function protectedResourceMetadata(req, cfg = {}) {
  const resource = resourceUri(req, cfg);
  const servers = normalizeServers(cfg.authorizationServers);
  return {
    resource,
    // Optional in the RFC, but an agent can do nothing without it — see the challenge
    // below, which says so out loud rather than serving an empty document.
    ...(servers.length ? { authorization_servers: servers } : {}),
    scopes_supported: cfg.scopes?.length ? cfg.scopes : ['trove:read', 'trove:write'],
    bearer_methods_supported: ['header'],
    resource_name: cfg.resourceName || 'Trove',
    ...(cfg.documentation ? { resource_documentation: cfg.documentation } : {}),
  };
}

/**
 * The 401 an agent is meant to receive: a challenge that points at the metadata.
 *
 * `error_description` carries the operator-facing half. An agent will ignore it, but a
 * person reading a failed connection in their client's log is the one who can actually
 * fix a missing authorization server, and "401" on its own tells them nothing.
 */
export function challengeHeaders(req, cfg = {}, { error = 'invalid_token', description } = {}) {
  const resource = resourceUri(req, cfg);
  const servers = normalizeServers(cfg.authorizationServers);
  // The missing-server note is APPENDED rather than used as a fallback. Whatever went
  // wrong with this particular request, "there is nowhere configured to get a token"
  // is the thing that will keep going wrong until someone fixes it, and it must not be
  // displaced by a more specific message about the immediate failure.
  const detail = [
    description || 'Present a bearer token from the configured authorization server.',
    servers.length ? null
      : 'No MCP authorization server is configured on this drive. Set TROVE_MCP_AUTH_SERVER, '
        + 'or configure it in Settings, to the issuer URL of your identity provider.',
  ].filter(Boolean).join(' ');
  return {
    'www-authenticate': `Bearer realm="Trove", error="${error}", `
      + `error_description="${headerSafe(detail)}", `
      + `resource_metadata="${metadataUrl(resource)}"`,
  };
}

/**
 * Make a string safe to put in an HTTP header value.
 *
 * Header values are bytes, not text: a curly quote or an em dash — the kind of thing
 * that shows up the moment a message is written for a person to read — makes the whole
 * response throw at construction time, turning a helpful 401 into a 500. Quotes would
 * also end the quoted-string early, so those go too.
 */
function headerSafe(text) {
  return String(text)
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, "'")
    .replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...')
    .replace(/["\\]/g, "'")
    // Anything else outside printable ASCII, and any control character, is dropped
    // rather than guessed at.
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeServers(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list.map((s) => String(s).trim().replace(/\/+$/, '')).filter(Boolean);
}

/**
 * MCP configuration, with a runtime layer on top of the environment.
 *
 * Env alone would mean a self-hoster has to redeploy to point at a different IdP, which
 * for the person running this on a NAS is the difference between "configurable" and
 * "not". So an admin can set it through the API and it lands in KV; the environment
 * remains the default and the fallback.
 */
export class McpConfigStore {
  constructor({ kv, defaults = {} } = {}) {
    this.kv = kv;
    this.defaults = defaults;
    this._cache = null;
  }

  async get() {
    if (this._cache) return this._cache;
    let stored = null;
    try {
      stored = await this.kv?.get(KV_NS, KV_KEY);
    } catch {
      // A KV that can't be read is not a reason to refuse MCP entirely — fall back to
      // the environment, which is what the deployment was configured with anyway.
    }
    this._cache = { ...this.defaults, ...(stored || {}) };
    return this._cache;
  }

  /** Replace the stored overrides. Only the fields an operator should be able to move. */
  async set(patch = {}) {
    const clean = {};
    if ('authorizationServers' in patch) clean.authorizationServers = normalizeServers(patch.authorizationServers);
    if ('resource' in patch) clean.resource = patch.resource ? String(patch.resource).replace(/\/+$/, '') : null;
    if ('scopes' in patch) clean.scopes = (patch.scopes || []).map(String).filter(Boolean);
    if ('enabled' in patch) clean.enabled = !!patch.enabled;
    if ('requireAuth' in patch) clean.requireAuth = patch.requireAuth == null ? null : !!patch.requireAuth;
    const current = await this.kv?.get(KV_NS, KV_KEY).catch(() => null);
    const next = { ...(current || {}), ...clean };
    await this.kv?.set(KV_NS, KV_KEY, next);
    this._cache = { ...this.defaults, ...next };
    return this._cache;
  }
}

/** Read MCP settings out of the process environment. */
export function mcpConfigFromEnv(env = {}) {
  const cfg = {};
  if (env.TROVE_MCP != null) cfg.enabled = !/^(0|off|false|no)$/i.test(String(env.TROVE_MCP));
  if (env.TROVE_MCP_PATH) cfg.path = env.TROVE_MCP_PATH;
  if (env.TROVE_MCP_AUTH_SERVER) cfg.authorizationServers = normalizeServers(env.TROVE_MCP_AUTH_SERVER);
  if (env.TROVE_MCP_RESOURCE) cfg.resource = String(env.TROVE_MCP_RESOURCE).replace(/\/+$/, '');
  if (env.TROVE_MCP_SCOPES) cfg.scopes = env.TROVE_MCP_SCOPES.split(',').map((s) => s.trim()).filter(Boolean);
  if (env.TROVE_MCP_REQUIRE_AUTH != null) cfg.requireAuth = !/^(0|off|false|no)$/i.test(String(env.TROVE_MCP_REQUIRE_AUTH));
  return cfg;
}

export { normalizeServers };
