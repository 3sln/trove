// Build plugin package zips for tests: a manifest + a plugin.js that uses the
// injected `trove` SDK. Optionally signs the package so we can exercise the
// domain-verified trust path.

import { zipSync, strToU8 } from 'fflate';
import { signManifest, generateSigningKey, fingerprintOf } from '../src/platform/pluginSigning.js';

// The demo entry: an offline-capable command, a network-only one, a status item,
// and a "hang" command that genuinely blocks the frame (for heartbeat tests).
export const PLUGIN_ENTRY = `
window.trove.activate(async (ctx) => {
  ctx.commands.register('demo.tap', () => ctx.ui.toast('tap'), { title: 'Demo: Tap', offline: true });
  ctx.commands.register('demo.sync', () => ctx.ui.toast(ctx.online ? 'synced' : 'offline'), { title: 'Demo: Sync to cloud', offline: false });
  ctx.commands.register('demo.hang', () => { for (;;) {} }, { title: 'Demo: (simulate hang)', offline: true });
  ctx.contributes.statusItem({ id: 'demo.status', align: 'right', text: 'demo', offline: true });
  // read a packaged resource via an opaque handle
  ctx.resources.text('data.txt').then((t) => { window.__resourceText = t; });
  if (ctx.capabilities.includes('storage')) await ctx.db.set('installs', 1).catch(() => {});
  // Brokered network: fetch a declared endpoint (allowed) and an undeclared one
  // (blocked). Returns the outcome so the host/e2e can assert enforcement.
  if (ctx.capabilities.includes('network')) {
    ctx.commands.register('demo.net', async () => {
      const base = (ctx.manifest.network || [])[0];
      const r = await ctx.net.fetch(base + 'api/capabilities');
      let blocked = 'ALLOWED';
      try { await ctx.net.fetch('https://blocked.example.com/steal'); } catch { blocked = 'BLOCKED'; }
      return { status: r.status, ok: r.ok, blocked };
    }, { title: 'Demo: Net', offline: false });
  }
});
`;

export function baseManifest(overrides = {}) {
  return {
    id: 'com.trove.demo',
    name: 'Demo Plugin',
    version: '1.2.3',
    description: 'A demo plugin used in tests — a couple of commands, a status item, and a packaged resource.',
    author: 'Trove Tests',
    entry: 'plugin.js',
    capabilities: ['storage', 'ui', 'commands'],
    contributes: {
      commands: [
        { id: 'demo.tap', title: 'Demo: Tap', offline: true },
        { id: 'demo.sync', title: 'Demo: Sync to cloud', offline: false },
      ],
    },
    settings: [
      { key: 'greeting', type: 'string', title: 'Greeting', default: 'hi' },
      { key: 'apiKey', type: 'string', title: 'API key', secret: true },
    ],
    ...overrides,
  };
}

/**
 * @param {object} [opts]
 * @param {object} [opts.manifest] manifest overrides
 * @param {boolean} [opts.sign] sign the package
 * @param {string} [opts.domain] declare a domain (for verification)
 * @returns {Promise<{ zip: Uint8Array, manifest: object, fingerprint?: string }>}
 */
export async function buildPackage(opts = {}) {
  let manifest = baseManifest(opts.manifest);
  if (opts.domain) manifest.domain = opts.domain;
  const files = new Map([
    ['plugin.js', strToU8(PLUGIN_ENTRY)],
    ['data.txt', strToU8('hello from a packaged resource')],
  ]);
  let fingerprint;
  if (opts.sign) {
    const keyPair = await generateSigningKey();
    manifest = await signManifest(manifest, files, keyPair);
    fingerprint = await fingerprintOf(manifest.publicKey);
  }
  const entries = { 'manifest.json': strToU8(JSON.stringify(manifest)) };
  for (const [k, v] of files) entries[k] = v;
  return { zip: zipSync(entries), manifest, fingerprint };
}

/** An assetlinks doc that vouches for `fingerprint` for `pluginId`. */
export function assetlinksFor(fingerprint, pluginId) {
  return { version: 1, keys: [{ fingerprint, plugins: [pluginId] }] };
}
