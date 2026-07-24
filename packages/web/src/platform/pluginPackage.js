// Plugin packages — a plugin is a zip: manifest.json + an entry script + assets.
// This parses/validates a package (from an uploaded file or a fetched URL) and
// produces the summary shown in the pre-install review. Nothing here runs plugin
// code — that only happens later, inside a sandboxed iframe.

import { unzipSync } from 'fflate';
import { parseEndpoint, endpointSummary } from './pluginNet.js';

const CAP_DESCRIPTIONS = {
  files: 'Read your files, folders, and search index (via the host).',
  storage: 'Keep its own SQLite database(s) — on the server and/or on this device.',
  ui: 'Show a popup panel and toasts.',
  commands: 'Add commands to the palette.',
  opener: 'Preview/open file types.',
  indexer: 'Add searchable content to your files.',
  network: 'Connect to the internet — only the endpoints it declares (shown below).',
};

// Capabilities that need an admin to grant (they touch shared data). None at the
// moment — the `storage.domain` scope is instead gated on domain verification.
export const ADMIN_ONLY_CAPS = new Set();

/**
 * The storage scopes a manifest declares: `{ plugin, domain }`. Each is a separate
 * lazily-created SQLite database (server + client). The `domain` scope — shared
 * across a vendor's plugins — is only usable by a domain-verified package.
 */
export function storageScopes(manifest) {
  const opt = capabilityOptions(manifest, 'storage');
  if (!opt) return { plugin: false, domain: false };
  // `storage: true` (or `{}`) → the private plugin scope, nothing shared.
  if (opt === true || (typeof opt === 'object' && !('plugin' in opt) && !('domain' in opt))) {
    return { plugin: true, domain: false };
  }
  return { plugin: !!opt.plugin, domain: !!opt.domain };
}

export function describeCapability(cap) {
  return CAP_DESCRIPTIONS[cap] || cap;
}

// Capabilities are declared as an object: each key is a capability, each value is
// that capability's options. A capability that takes no options uses `true` (or an
// empty object). e.g. { ui: true, network: { endpoints: ["https://api.example.com/"] } }.
// A plain array of ids is also accepted (each treated as options-less) so simple
// or hand-written manifests stay easy.
export function capabilityEntries(manifest) {
  const caps = manifest && manifest.capabilities;
  const out = {};
  if (Array.isArray(caps)) {
    for (const id of caps) if (id) out[id] = {};
  } else if (caps && typeof caps === 'object') {
    for (const [id, val] of Object.entries(caps)) {
      if (val === false || val == null) continue; // explicitly not requested
      out[id] = val === true ? {} : val;
    }
  }
  return out;
}

/** The declared capability ids. */
export function capabilityList(manifest) {
  return Object.keys(capabilityEntries(manifest));
}

/** Options declared for one capability, or null if it isn't declared. */
export function capabilityOptions(manifest, id) {
  const e = capabilityEntries(manifest);
  return Object.prototype.hasOwnProperty.call(e, id) ? e[id] : null;
}

/** The network capability's declared endpoint prefixes (accepts a few shapes). */
export function networkEndpoints(manifest) {
  const opt = capabilityOptions(manifest, 'network');
  if (opt) {
    if (Array.isArray(opt)) return opt;                 // network: ["https://…"]
    if (Array.isArray(opt.endpoints)) return opt.endpoints;
    if (Array.isArray(opt.prefixes)) return opt.prefixes;
  }
  if (Array.isArray(manifest.network)) return manifest.network; // legacy top-level
  return [];
}

/** Parse zip bytes into { manifest, files:Map<path,Uint8Array>, raw }. */
export function parsePackage(zipBytes) {
  let entries;
  try {
    entries = unzipSync(zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes));
  } catch (err) {
    throw new Error('Not a valid zip archive: ' + err.message);
  }
  const files = new Map();
  for (const [path, bytes] of Object.entries(entries)) {
    if (!path.endsWith('/')) files.set(path.replace(/^\.?\//, ''), bytes);
  }
  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) throw new Error('Package is missing manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch (err) {
    throw new Error('manifest.json is not valid JSON: ' + err.message);
  }
  validateManifest(manifest, files);
  return { manifest, files, raw: zipBytes };
}

function validateManifest(m, files) {
  const need = (c, msg) => { if (!c) throw new Error(msg); };
  need(m.id && /^[a-z0-9][a-z0-9._-]{2,}$/i.test(m.id), 'manifest.id is required (reverse-domain style)');
  need(m.name, 'manifest.name is required');
  need(m.entry, 'manifest.entry (path to the plugin script) is required');
  need(files.has(m.entry), `entry "${m.entry}" is not in the package`);
  if (m.capabilities != null) {
    need(Array.isArray(m.capabilities) || typeof m.capabilities === 'object',
      'capabilities must be an object of { capability: options } (or an array of ids)');
  }
  if (m.icon) need(files.has(m.icon), `icon "${m.icon}" is not in the package`);
  for (const ep of networkEndpoints(m)) parseEndpoint(ep); // throws on anything but an http(s) URL
}

/** Fetch a package from a URL (must be a zip). */
export async function fetchPackage(url, fetchFn = globalThis.fetch.bind(globalThis)) {
  let res;
  try {
    res = await fetchFn(url);
  } catch (err) {
    throw new Error('Could not fetch the plugin: ' + err.message);
  }
  if (!res.ok) throw new Error(`Could not fetch the plugin (HTTP ${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return parsePackage(bytes);
}

/** The entry script text. */
export function entrySource(pkg) {
  return new TextDecoder().decode(pkg.files.get(pkg.manifest.entry));
}

/** A blob: URL for the icon, usable in the host UI (bytes copied into the host). */
export function iconUrl(pkg) {
  if (!pkg.manifest.icon) return null;
  const bytes = pkg.files.get(pkg.manifest.icon);
  if (!bytes) return null;
  const mime = pkg.manifest.icon.endsWith('.svg') ? 'image/svg+xml' : pkg.manifest.icon.endsWith('.png') ? 'image/png' : 'image/*';
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

/** A flat, review-friendly summary of everything the package declares. */
export function reviewSummary(pkg, trust) {
  const m = pkg.manifest;
  const c = m.contributes || {};
  const contributions = [
    ...(c.commands || []).map((x) => ({ kind: 'command', title: x.title || x.id, offline: !!x.offline })),
    ...(c.openers || []).map((x) => ({ kind: 'opener', title: x.title || x.id, detail: selectorText(x.selector), offline: !!x.offline })),
    ...(c.indexers || []).map((x) => ({ kind: 'indexer', title: x.title || x.id })),
  ];
  const verified = trust?.status === 'verified';
  const scopes = storageScopes(m);
  return {
    id: m.id, name: m.name, version: m.version || '0.0.0', description: m.description || '',
    author: m.author || 'Unknown', domain: m.domain || null,
    capabilities: capabilityList(m).map((cap) => ({ id: cap, description: describeCapability(cap), adminOnly: ADMIN_ONLY_CAPS.has(cap) })),
    contributions,
    settings: (m.settings || []).map((s) => ({ key: s.key, title: s.title || s.key, type: s.type, secret: !!s.secret })),
    network: endpointSummary(networkEndpoints(m)),
    // Which SQLite stores it wants. `domain` (shared across a vendor's plugins) is
    // only grantable for a verified package; flag it so the review can say why.
    storage: (scopes.plugin || scopes.domain)
      ? { plugin: scopes.plugin, domain: scopes.domain, domainBlocked: scopes.domain && !verified }
      : null,
    fileCount: pkg.files.size,
    sizeBytes: [...pkg.files.values()].reduce((n, b) => n + b.length, 0),
    trust,
  };
}

/** The storage scopes actually granted at install: plugin if declared, domain if
 * declared AND the package is domain-verified. */
export function grantedStorageScopes(manifest, trust) {
  const s = storageScopes(manifest);
  return { plugin: s.plugin, domain: s.domain && trust?.status === 'verified' };
}

function selectorText(sel) {
  if (!sel) return '';
  const parts = [];
  if (sel.ext?.length) parts.push(sel.ext.join(', '));
  if (sel.mime?.length) parts.push(sel.mime.join(', '));
  return parts.join(' · ');
}
