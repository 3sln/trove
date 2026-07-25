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
 * Contributions are DECLARED IN THE MANIFEST, and the manifest is authoritative: the
 * host registers exactly what's declared, so what the user approves at install is what
 * the plugin gets. (Contributions used to be dynamic `contribute:*` calls at runtime,
 * unrelated to the manifest the review dialog showed.)
 *
 *   "contributes": {
 *     "openers":  [{ id, title, match: {ext,mime}, entry: "src/openers/player.js", … }],
 *     "indexers": [{ id, title, match, entry: "src/indexers/pdf.js", server?: true }],
 *     "commands": [{ id, title, category?, icon?, when?, offline? }],
 *     "statusItems": [...], "keybindings": [...]
 *   }
 *
 * `entry` points at a module inside the plugin's ONE module tree — openers and indexers
 * are not nested packages, so everything in a plugin shares modules and code. What gets
 * opened/indexed just depends on which entry module runs.
 */
function declared(manifest, kind) {
  const list = manifest?.contributes?.[kind];
  return Array.isArray(list) ? list.filter((x) => x && (x.id || x.key)) : [];
}

/** Openers a package declares, each pointing at its entry module. */
export function declaredOpeners(manifest) {
  return declared(manifest, 'openers').map((o) => ({
    id: o.id,
    title: o.title || o.id,
    selector: o.match || o.selector || {},
    entry: o.entry || manifest?.entry,
    priority: o.priority ?? 50,
    offline: !!o.offline,
    dock: o.dock || null,
  }));
}

/** Indexers a package declares. `server: true` runs in the server isolate runtime. */
export function declaredIndexers(manifest) {
  return declared(manifest, 'indexers').map((i) => ({
    id: i.id,
    title: i.title || i.id,
    selector: i.match || i.selector || {},
    entry: i.entry || manifest?.entry,
    server: !!i.server,
    offline: !!i.offline,
  }));
}

/**
 * The indexers a plugin runs SERVER-side (`contributes.indexers[].server: true`) — the
 * ones that make a package account-scoped and admin-gated, since they ship code the
 * server executes. Their `entry` is a module in the plugin's own tree, so a server
 * indexer shares code with the rest of the plugin.
 *
 * `manifest.serverIndexers: [{ id, match, entry }]` is still accepted as a legacy
 * top-level form.
 */
export function serverIndexers(manifest) {
  const out = declaredIndexers(manifest)
    .filter((i) => i.server)
    .map((i) => ({ id: i.id, match: i.selector, entry: i.entry }));
  for (const spec of manifest?.serverIndexers || []) {
    if (spec?.id && !out.some((o) => o.id === spec.id)) {
      out.push({ id: spec.id, match: spec.match || {}, entry: spec.entry || manifest?.entry });
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
    indexers: serverIndexers(manifest),
    openers: declaredOpeners(manifest),
    sharedStorage: usesSharedStorage(manifest),
    digest: await digestBytes(bytes),
  };
}
