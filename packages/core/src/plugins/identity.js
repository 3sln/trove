// Plugin identity and contribution URIs.
//
// A plugin is identified by its DOMAIN plus its NAME — never by a self-chosen opaque
// id. The domain is proven (the package is signed, and the domain publishes the
// signing key via assetlinks), so identity is verifiable rather than claimed. That
// gives us three things at once:
//
//   • no squatting: only acme.com can publish acme.com/docs
//   • versioning: acme.com/docs@2 is the same plugin as acme.com/docs@1, and a
//     different plugin from acme.com/sheets — which a self-chosen id can't express
//   • no cross-kind collisions: every contribution lives under its plugin, so an
//     opener, a status slot, a register and a command can all be called "status"
//     without colliding with each other or with another plugin's "status".
//
// Every contribution is addressed by a URI:
//
//   trove+contrib:<domain>/<plugin>/<contribution>
//   e.g. trove+contrib:acme.com/docs/pdfViewer
//
// The host's own built-in contributions use the reserved `core` domain, so the
// address space has exactly one shape:  trove+contrib:core/workbench/explorer.delete

import { TroveError } from '../errors.js';

export const CONTRIB_SCHEME = 'trove+contrib:';
export const CORE_DOMAIN = 'core';

// A DNS-ish domain (lowercase labels, dots) — or the reserved `core`.
const DOMAIN_RE = /^(?:core|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/;
// A plugin or contribution name: lowercase-ish segment, no slashes or spaces.
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function isValidDomain(domain) {
  return typeof domain === 'string' && DOMAIN_RE.test(domain);
}
export function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

/** The plugin's identity: `<domain>/<name>`. Stable across versions. */
export function pluginId(manifest) {
  assertIdentity(manifest);
  return `${manifest.domain}/${manifest.name}`;
}

/** The full URI for one of a plugin's contributions. */
export function contribUri(manifest, contributionName) {
  if (!isValidName(contributionName)) {
    throw TroveError.invalid(`Invalid contribution name "${contributionName}"`);
  }
  return `${CONTRIB_SCHEME}${pluginId(manifest)}/${contributionName}`;
}

// The host's own contributions are addressed exactly like a plugin's: the reserved
// `core` domain, and `workbench` as the package within it. So the address space has
// one shape everywhere, and core names share a single namespace just as a plugin's do.
export const CORE_PACKAGE = 'workbench';

/** A URI for one of the host's own built-in contributions. */
export function coreUri(name) {
  return `${CONTRIB_SCHEME}${CORE_DOMAIN}/${CORE_PACKAGE}/${name}`;
}

/** Parse a contribution URI into its parts, or null if it isn't one. */
export function parseContribUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith(CONTRIB_SCHEME)) return null;
  const rest = uri.slice(CONTRIB_SCHEME.length);
  const i = rest.indexOf('/');
  const j = rest.indexOf('/', i + 1);
  if (i < 0 || j < 0) return null;
  const domain = rest.slice(0, i);
  const plugin = rest.slice(i + 1, j);
  const name = rest.slice(j + 1);
  if (!domain || !plugin || !name) return null;
  return { domain, plugin, name, pluginId: `${domain}/${plugin}` };
}

/** Whether `uri` belongs to the plugin described by `manifest`. */
export function ownsUri(manifest, uri) {
  const p = parseContribUri(uri);
  return !!p && p.pluginId === `${manifest.domain}/${manifest.name}`;
}

/**
 * Every package must carry a verifiable identity: a domain it belongs to and a name
 * within that domain. Anonymous/self-identified packages are not installable.
 */
export function assertIdentity(manifest) {
  if (!isValidDomain(manifest?.domain)) {
    throw TroveError.invalid(`Plugin manifest needs a valid "domain" (got ${JSON.stringify(manifest?.domain)})`);
  }
  if (!isValidName(manifest?.name)) {
    throw TroveError.invalid(`Plugin manifest needs a valid "name" (got ${JSON.stringify(manifest?.name)})`);
  }
  if (manifest.domain === CORE_DOMAIN) {
    throw TroveError.invalid('The "core" domain is reserved for built-in contributions');
  }
}
