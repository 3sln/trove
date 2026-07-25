// Server-side plugin package parsing. The server independently re-parses an uploaded
// package (never trusting the client that produced it), pulling out the manifest, the
// verified identity, the declared capabilities and contributions, and a content digest
// used for dedupe/integrity.

import { unzipSync, strFromU8 } from 'fflate';
import { TroveError } from '../errors.js';
import { assertIdentity, pluginId } from './identity.js';
import { declaredContributions, serverIndexers, declaredOpeners } from './contributions.js';

export const ALL_CAPABILITIES = ['files', 'storage', 'ui', 'commands', 'indexer', 'opener', 'network', 'media', 'dock'];

export { serverIndexers, declaredOpeners, declaredContributions };

/** SHA-256 hex digest of the raw package bytes (content address). */
export async function digestBytes(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return 'sha256:' + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Declared capability ids from a manifest (object `{cap: opts}` or array form). */
export function capabilityList(manifest) {
  const caps = manifest && manifest.capabilities;
  if (Array.isArray(caps)) return caps.filter(Boolean);
  if (caps && typeof caps === 'object') {
    return Object.entries(caps).filter(([, v]) => v !== false && v != null).map(([k]) => k);
  }
  return [];
}

/** Whether the granted storage includes the shared `domain` scope. */
export function usesSharedStorage(manifest) {
  const opt = manifest?.capabilities?.storage;
  return !!(opt && typeof opt === 'object' && opt.domain);
}

/**
 * Parse an uploaded package zip. Returns { manifest, pluginId, files, capabilities,
 * contributions, indexers, openers, digest }. Throws INVALID on a missing/malformed
 * manifest, an unverifiable identity, or a bad contribution declaration.
 * @param {Uint8Array} bytes
 */
export async function parsePluginPackage(bytes) {
  let files;
  try {
    files = unzipSync(bytes);
  } catch (err) {
    throw TroveError.invalid('Package is not a valid zip', { cause: err });
  }
  const manifestRaw = files['manifest.json'];
  if (!manifestRaw) throw TroveError.invalid('Package is missing manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(strFromU8(manifestRaw));
  } catch (err) {
    throw TroveError.invalid('manifest.json is not valid JSON', { cause: err });
  }
  // Identity first: everything else (contribution URIs, install records, storage
  // scopes) is addressed under `<domain>/<name>`, so an anonymous package has no
  // address space to live in and is rejected outright.
  assertIdentity(manifest);
  const capabilities = capabilityList(manifest).filter((c) => ALL_CAPABILITIES.includes(c));
  return {
    manifest,
    pluginId: pluginId(manifest),
    files,
    capabilities,
    contributions: declaredContributions(manifest),
    indexers: serverIndexers(manifest),
    openers: declaredOpeners(manifest),
    sharedStorage: usesSharedStorage(manifest),
    digest: await digestBytes(bytes),
  };
}
