// Plugin packages — a plugin is a zip: manifest.json + an entry script + assets.
// This parses/validates a package (from an uploaded file or a fetched URL) and
// produces the summary shown in the pre-install review. Nothing here runs plugin
// code — that only happens later, inside a sandboxed iframe.

import { unzipSync } from 'fflate';
import { parseEndpoint, endpointSummary } from './pluginNet.js';
import { assertIdentity, pluginId, ownsUri, parseContribUri } from '@3sln/trove/core/plugins/identity.js';
import { declaredContributions } from '@3sln/trove/core/plugins/contributions.js';

const CAP_DESCRIPTIONS = {
  files: 'Read your files, folders, and search index (via the host).',
  storage: 'Keep its own SQLite database(s) — on the server and/or on this device.',
  ui: 'Show a popup panel and toasts.',
  commands: 'Add commands to the palette, and run the specific host commands it lists.',
  opener: 'Preview/open file types.',
  // Distinct from a declared indexer (which the SERVER runs on every upload): this
  // capability lets the plugin itself push searchable content for a file it's looking at.
  indexer: 'Add searchable content to your files.',
  network: 'Connect to the internet — only the endpoints it declares (shown below).',
  media: 'Show playback controls on your lock screen and notifications while it plays media.',
  dock: 'Keep its viewer in a small floating window when you navigate away.',
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

/** The human-facing name: `displayName` if given, else the package name. */
export function displayName(manifest) {
  // A STRING, always — and this is a security boundary, not tidiness.
  //
  // dodo decides "is this argument a props map or a child?" by `x.constructor === Object`,
  // and every prop on an HTML element is assigned as a DOM PROPERTY. `JSON.parse` gives
  // objects whose constructor is Object, so a manifest with
  // `"displayName": {"innerHTML": "<img src=x onerror=…>"}` — nothing validates it —
  // reaches `span(plugin.name)` in the plugin panel and `h3(g.category)` in Settings as
  // the FIRST argument, becomes the element's prop map, and executes in the host page.
  // That is a complete escape from the opaque-origin, connect-src 'none' iframe.
  const name = manifest?.displayName ?? manifest?.name;
  return typeof name === 'string' && name.trim() ? name : 'Plugin';
}

/**
 * The exact commands this plugin may ASK THE HOST TO RUN (ctx.commands.execute), each
 * named by the URI it's contributed at — a built-in like `explorer.download`, or
 * another plugin's `trove+contrib:acme.com/docs/export`. Like `network`, the
 * capability carries its allowlist rather than being a blanket grant: "can run
 * commands" is meaningless as a yes/no, because the interesting question is always
 * *which* ones (`explorer.delete` is not `workbench.view.home`).
 * Accepted shapes:
 *   commands: true                          → contribute-only; executes nothing external
 *   commands: ["explorer.download", …]      → exactly these
 *   commands: { execute: ["…"] }            → exactly these
 * A plugin may always execute its own commands — that's just calling itself.
 */
export function executableCommands(manifest) {
  const opt = capabilityOptions(manifest, 'commands');
  if (!opt) return [];
  if (Array.isArray(opt)) return opt.filter(Boolean);
  if (Array.isArray(opt.execute)) return opt.execute.filter(Boolean);
  return [];
}

/**
 * Whether `commandUri` is executable by the plugin described by `manifest`. A plugin
 * always owns its own contributions (the URI is scoped under its domain and name), so
 * ownership is decided by the address itself rather than by a naming convention or a
 * registry lookup that could be raced.
 */
export function canExecuteCommand(manifest, commandUri, _ownerPluginId) {
  if (!commandUri) return false;
  if (parseContribUri(commandUri) && ownsUri(manifest, commandUri)) return true;
  return executableCommands(manifest).includes(commandUri);
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
  // Identity is mandatory: a package must say which DOMAIN it belongs to and its NAME
  // within that domain. There is no anonymous/self-identified install — every
  // contribution is addressed under `<domain>/<name>`, and the domain is what makes
  // that address verifiable rather than merely claimed.
  assertIdentity(m);
  need(m.entry, 'manifest.entry (path to the plugin script) is required');
  need(files.has(m.entry), `entry "${m.entry}" is not in the package`);
  if (m.capabilities != null) {
    need(Array.isArray(m.capabilities) || typeof m.capabilities === 'object',
      'capabilities must be an object of { capability: options } (or an array of ids)');
  }
  if (m.icon) need(files.has(m.icon), `icon "${m.icon}" is not in the package`);
  // Throws on a bad type, a missing entry module, or a malformed option — the review
  // dialog must be able to show exactly what will be registered.
  for (const c of declaredContributions(m)) {
    if (c.entry) need(files.has(c.entry), `contribution "${c.name}" points at "${c.entry}", which is not in the package`);
    if (c.type === 'keymap') need(files.has(c.path), `keymap "${c.name}" points at "${c.path}", which is not in the package`);
  }
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

/** A flat, review-friendly summary of everything the package declares. */
export function reviewSummary(pkg, trust) {
  const m = pkg.manifest;
  const contributions = declaredContributions(m).map((c) => ({
    kind: c.type, name: c.name, uri: c.uri,
    title: c.title || c.name,
    detail: c.type === 'opener' || c.type === 'indexer' ? selectorText(c.match)
      // What it RUNS, not just where it sits. A status item can carry a command, and a
      // review that only said "right of the status bar" gave the user nothing to refuse.
      : c.type === 'statusItem' ? `${c.slot} of the status bar${c.command ? ` — runs ${c.command}` : ''}`
        : c.type === 'keymap' ? c.path : '',
    offline: !!c.offline,
  }));
  const verified = trust?.status === 'verified';
  const scopes = storageScopes(m);
  return {
    id: pluginId(m), name: displayName(m), version: m.version || '0.0.0', description: m.description || '',
    author: m.author || 'Unknown', domain: m.domain,
    capabilities: capabilityList(m).map((cap) => ({ id: cap, description: describeCapability(cap), adminOnly: ADMIN_ONLY_CAPS.has(cap) })),
    contributions,
    settings: (m.settings || []).map((s) => ({ key: s.key, title: s.title || s.key, type: s.type, secret: !!s.secret })),
    network: endpointSummary(networkEndpoints(m)),
    // Exactly which host commands it may run. Resolved to titles by the review UI,
    // which has the command registry; here we just surface the declared ids.
    commands: executableCommands(m),
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
