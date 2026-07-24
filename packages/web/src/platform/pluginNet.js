// Declared network endpoints — the allowlist a plugin must publish before it can
// talk to the web. The sandboxed iframe can't reach the network at all (strict
// `connect-src 'none'` CSP + opaque origin); every request is brokered by the host
// over the MessagePort, and the host only makes it if the URL matches one of these
// declared endpoints. So the manifest's `network` array is the *complete* list of
// hosts a plugin can ever reach, shown to the user at install time and enforced at
// runtime.
//
// An endpoint is a URL prefix: scheme + host (optionally `*.`-wildcarded) + port +
// path prefix. A request matches when its scheme, host, port, and path-prefix all
// agree. Query strings and fragments are ignored in the pattern.

/** Parse one endpoint pattern; throws on anything that isn't an http(s) URL. */
export function parseEndpoint(pattern) {
  let u;
  try {
    u = new URL(pattern);
  } catch {
    throw new Error(`Invalid network endpoint "${pattern}" (must be an absolute http(s) URL)`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Network endpoint "${pattern}" must use http or https`);
  }
  const rawHost = u.hostname.toLowerCase();
  const wildcard = rawHost.startsWith('*.');
  const host = wildcard ? rawHost.slice(2) : rawHost;
  if (!host) throw new Error(`Network endpoint "${pattern}" has no host`);
  return { scheme: u.protocol, host, wildcard, port: u.port, pathPrefix: u.pathname || '/', raw: pattern };
}

/** Parse a manifest's `network` list, silently dropping malformed entries. */
export function normalizeEndpoints(list) {
  const out = [];
  for (const p of list || []) {
    try { out.push(parseEndpoint(p)); } catch { /* skip — validated separately at parse time */ }
  }
  return out;
}

/** Does a request URL fall under a single parsed endpoint? */
export function matchesEndpoint(ep, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== ep.scheme) return false;
  const host = u.hostname.toLowerCase();
  if (ep.wildcard) {
    if (host !== ep.host && !host.endsWith('.' + ep.host)) return false;
  } else if (host !== ep.host) {
    return false;
  }
  if (u.port !== ep.port) return false; // '' === '' for default ports (browser normalizes)
  return u.pathname.startsWith(ep.pathPrefix);
}

/** Is `url` allowed by the plugin's declared endpoint list? */
export function isAllowedUrl(endpoints, url) {
  return normalizeEndpoints(endpoints).some((ep) => matchesEndpoint(ep, url));
}

/** A human-friendly summary of declared endpoints for the review UI. */
export function endpointSummary(endpoints) {
  return normalizeEndpoints(endpoints).map((e) => ({
    scheme: e.scheme.replace(':', ''),
    host: (e.wildcard ? '*.' : '') + e.host + (e.port ? ':' + e.port : ''),
    path: e.pathPrefix === '/' ? '' : e.pathPrefix,
    raw: e.raw,
  }));
}
