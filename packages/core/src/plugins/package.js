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

// A package's COMPRESSED size is capped at the route; its INFLATED size was not, and a
// zip will happily turn 1 MB into 1 GB. `unzipSync` is synchronous, so that is a
// gigabyte of RSS and thirteen seconds of blocked event loop for one request — from an
// unauthenticated caller on the zero-config drive, since the install route only asks for
// a principal and the shared anonymous one satisfies it.
//
// fflate's `filter` runs against the central directory BEFORE any entry is inflated, so
// the declared sizes are the cheapest possible place to refuse. 64 MiB and 2,000 files
// are far beyond any real plugin (the largest thing in one is a wasm blob) and far below
// what hurts.
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 2000;

export function boundedUnzip(bytes) {
  let total = 0;
  let count = 0;
  try {
    return unzipSync(bytes, {
      filter(file) {
        if (++count > MAX_ENTRIES) throw TroveError.tooLarge(`Package has more than ${MAX_ENTRIES} files`);
        total += file.originalSize || 0;
        if (total > MAX_INFLATED_BYTES) {
          throw TroveError.tooLarge(`Package expands to more than ${Math.round(MAX_INFLATED_BYTES / 1024 / 1024)} MB`);
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof TroveError) throw err;
    throw TroveError.invalid('Package is not a valid zip', { cause: err });
  }
}

/**
 * Parse an uploaded package zip. Returns { manifest, pluginId, files, capabilities,
 * contributions, indexers, openers, digest }. Throws INVALID on a missing/malformed
 * manifest, an unverifiable identity, or a bad contribution declaration.
 * @param {Uint8Array} bytes
 */
export async function parsePluginPackage(bytes) {
  const files = boundedUnzip(bytes);
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
