// Telling a client where to sign in.
//
// Trove doesn't run a login system — it verifies tokens somebody else issued. So every
// unauthenticated request has the same problem: the client has been refused, and has no
// idea where to go and get a credential. A bare 401 is a dead end for a browser and an
// absolute dead end for an agent, which has no human to ask.
//
// OAuth 2.0 Protected Resource Metadata (RFC 9728) is the standard answer, and it is
// what the MCP authorization spec builds on — so implementing it once serves both. A
// refused request carries a pointer:
//
//   WWW-Authenticate: Bearer resource_metadata="https://drive/.well-known/oauth-protected-resource"
//
// and that document names the authorization server. ONE authorization server, for the
// whole drive. It is a property of the deployment — which identity provider sits in
// front of this thing — not of any particular endpoint, so the MCP endpoint and the JSON
// API answer with the same value and cannot drift apart.
//
// The deployment supplies it (env, or a field on the server config). Where it is not
// supplied but the JWT issuer is, that is used: for essentially every OIDC provider the
// issuer URL IS the authorization server, and making someone state the same URL twice
// is a way to have them disagree.

/** Normalize one-or-many authorization server URLs, trimming trailing slashes. */
export function normalizeServers(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list.map((s) => String(s).trim().replace(/\/+$/, '')).filter(Boolean);
}

/**
 * The public origin of this request, as the outside world sees it.
 *
 * Behind a reverse proxy the socket says `http://10.0.0.4:8080`, which is not an
 * identifier any token was ever issued for. The forwarded headers say what the client
 * actually asked for.
 */
export function publicOrigin(req) {
  const url = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host;
  return `${proto}://${host}`;
}

/**
 * Where the metadata document for a resource lives.
 *
 * RFC 9728 inserts the well-known segment BETWEEN the host and the path rather than
 * appending it, so a resource at `https://d/mcp` is described at
 * `https://d/.well-known/oauth-protected-resource/mcp`, and the drive itself at
 * `https://d/.well-known/oauth-protected-resource`. Appending instead is a common enough
 * mistake that clients have had to work around it.
 */
export function metadataUrl(resource) {
  const u = new URL(resource);
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.origin}/.well-known/oauth-protected-resource${path}`;
}

/**
 * The RFC 9728 document.
 *
 * @param {string} resource the canonical URI of what is being protected
 * @param {object} auth the drive's auth discovery config
 */
export function protectedResourceMetadata(resource, auth = {}) {
  const servers = normalizeServers(auth.authorizationServers);
  return {
    resource,
    // Optional in the RFC, but a client can do nothing without it — so when it is
    // missing the field is omitted rather than published empty, which would read as
    // "there are none" instead of "nobody configured this", and the challenge below
    // says so in words.
    ...(servers.length ? { authorization_servers: servers } : {}),
    scopes_supported: auth.scopes?.length ? auth.scopes : ['trove:read', 'trove:write'],
    bearer_methods_supported: ['header'],
    resource_name: auth.resourceName || 'Trove',
    ...(auth.documentation ? { resource_documentation: auth.documentation } : {}),
  };
}

/**
 * The challenge that turns a 401 into directions.
 *
 * `error_description` carries the operator-facing half. A client ignores it, but the
 * person reading a failed connection in a log is the one who can fix a missing
 * authorization server, and "401" on its own tells them nothing.
 */
export function challengeHeaders(resource, auth = {}, { error = 'invalid_token', description } = {}) {
  const servers = normalizeServers(auth.authorizationServers);
  // The missing-server note is APPENDED rather than used as a fallback. Whatever went
  // wrong with this particular request, "there is nowhere configured to get a token" is
  // the thing that will keep going wrong until someone fixes it, and it must not be
  // displaced by a more specific message about the immediate failure.
  const detail = [
    description || 'Present a bearer token from the configured authorization server.',
    servers.length ? null
      : 'No authorization server is configured on this drive. Set TROVE_AUTH_SERVER to the '
        + 'issuer URL of your identity provider (it defaults to TROVE_JWT_ISSUER when that is set).',
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
export function headerSafe(text) {
  return String(text)
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, "'")
    .replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...')
    .replace(/["\\]/g, "'")
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve the drive's auth-discovery settings from server config.
 *
 * The fallback to the JWT issuer is the useful part: a deployment that already told
 * Trove which issuer to trust has already told it where the authorization server is,
 * and asking for the same URL under a second name is a way to get two different answers.
 */
export function resolveAuthDiscovery(config = {}) {
  const explicit = normalizeServers(config.auth?.authorizationServers ?? config.authServer);
  const issuer = normalizeServers(config.identity?.jwt?.issuer);
  return {
    authorizationServers: explicit.length ? explicit : issuer,
    // Recorded so a UI can explain where the value came from — "we inferred this from
    // your JWT issuer" is a different fact from "you set this", and an operator
    // debugging a mismatch needs to know which.
    source: explicit.length ? 'configured' : issuer.length ? 'jwt-issuer' : 'none',
    scopes: config.auth?.scopes,
    resourceName: config.auth?.resourceName,
    documentation: config.auth?.documentation,
  };
}
