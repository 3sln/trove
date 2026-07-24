// Plugin packages — a plugin is a zip: manifest.json + an entry script + assets.
// This parses/validates a package (from an uploaded file or a fetched URL) and
// produces the summary shown in the pre-install review. Nothing here runs plugin
// code — that only happens later, inside a sandboxed iframe.

import { unzipSync } from 'fflate';

const CAP_DESCRIPTIONS = {
  files: 'Read your files, folders, and search index (via the host).',
  storage: 'Keep its own private data (local database).',
  serverStorage: 'Store its data on the server, synced across your devices.',
  ui: 'Show a popup panel and toasts.',
  commands: 'Add commands to the palette.',
  opener: 'Preview/open file types.',
  indexer: 'Add searchable content to your files.',
};

// Capabilities that a normal user may grant themselves vs. those that need an
// admin (they touch shared data or the server).
export const ADMIN_ONLY_CAPS = new Set(['serverStorage']);

export function describeCapability(cap) {
  return CAP_DESCRIPTIONS[cap] || cap;
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
  need(Array.isArray(m.capabilities || []), 'capabilities must be an array');
  if (m.icon) need(files.has(m.icon), `icon "${m.icon}" is not in the package`);
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
  return {
    id: m.id, name: m.name, version: m.version || '0.0.0', description: m.description || '',
    author: m.author || 'Unknown', domain: m.domain || null,
    capabilities: (m.capabilities || []).map((cap) => ({ id: cap, description: describeCapability(cap), adminOnly: ADMIN_ONLY_CAPS.has(cap) })),
    contributions,
    settings: (m.settings || []).map((s) => ({ key: s.key, title: s.title || s.key, type: s.type, secret: !!s.secret })),
    fileCount: pkg.files.size,
    sizeBytes: [...pkg.files.values()].reduce((n, b) => n + b.length, 0),
    trust,
  };
}

function selectorText(sel) {
  if (!sel) return '';
  const parts = [];
  if (sel.ext?.length) parts.push(sel.ext.join(', '));
  if (sel.mime?.length) parts.push(sel.mime.join(', '));
  return parts.join(' · ');
}
