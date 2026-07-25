// Server-side plugin package parsing. The server independently re-parses an uploaded
// package (never trusting the client that produced it), pulling out the manifest, the
// declared capabilities, any server-indexer sub-packages, and a content digest used
// for dedupe/integrity. Signature/trust re-verification is a follow-up (see the design
// doc); this covers structure + capabilities, which the scope/authz gate needs.

import { unzipSync, strFromU8 } from 'fflate';
import { TroveError } from '../errors.js';

export const ALL_CAPABILITIES = ['files', 'storage', 'ui', 'commands', 'indexer', 'opener', 'network', 'media', 'dock'];

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
 * Server-indexer sub-packages declared by the plugin. Two shapes are accepted:
 *   manifest.serverIndexers: [{ id, match, entry }]     — inline declaration
 *   files under `indexers/<id>/manifest.json`           — embedded sub-packages
 * (The isolate runtime that executes them is a later phase; here we only enumerate
 * them so the authz gate knows the plugin ships server code.)
 */
export function serverIndexers(manifest, files) {
  const out = [];
  for (const spec of manifest?.serverIndexers || []) if (spec?.id) out.push({ id: spec.id, match: spec.match || {}, entry: spec.entry || 'index.js' });
  for (const path of Object.keys(files || {})) {
    const m = /^indexers\/([^/]+)\/manifest\.json$/.exec(path);
    if (m) {
      try {
        const im = JSON.parse(strFromU8(files[path]));
        out.push({ id: im.id || m[1], match: im.match || {}, entry: im.entry || 'index.js', dir: `indexers/${m[1]}/` });
      } catch { /* skip malformed sub-manifest */ }
    }
  }
  return out;
}

/**
 * Parse an uploaded package zip. Returns { manifest, files, capabilities, indexers,
 * digest }. Throws INVALID on a missing/malformed manifest.
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
  if (!manifest.id || typeof manifest.id !== 'string') throw TroveError.invalid('manifest.id is required');
  const capabilities = capabilityList(manifest).filter((c) => ALL_CAPABILITIES.includes(c));
  return {
    manifest,
    files,
    capabilities,
    indexers: serverIndexers(manifest, files),
    sharedStorage: usesSharedStorage(manifest),
    digest: await digestBytes(bytes),
  };
}
