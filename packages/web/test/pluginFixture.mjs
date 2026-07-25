// Build plugin package zips for tests: a manifest + a plugin.js that uses the
// injected `trove` SDK. Optionally signs the package so we can exercise the
// domain-verified trust path.

import { zipSync, strToU8 } from 'fflate';
import { signManifest, generateSigningKey, fingerprintOf } from '../src/platform/pluginSigning.js';

// The demo plugin as ONE module tree: a main entry and an opener entry that share
// code (src/shared.js). Contributions are declared in the manifest — these modules
// only supply behaviour, addressed by id.

const SHARED = `
// Shared by the plugin's main entry AND its opener entry — the whole point of using
// one module tree instead of nested sub-packages.
export const label = (file) => 'Playing ' + ((file && file.name) || '');
export const BRAND = 'Trove';
`;

// The opener's entry module. The manifest says WHAT it opens; this says HOW.
export const OPENER_ENTRY = `
import { activate } from 'trove';
import { label, BRAND } from '../shared.js';
activate(async (ctx) => {
  ctx.onOpen(async (file) => {
    document.body.innerHTML = '';
    const el = document.createElement('div');
    el.id = 'demo-player';
    el.textContent = label(file);
    el.style.cssText = 'color:#fff;font:13px sans-serif;padding:10px;background:rgba(0,0,0,.6);border-radius:8px;';
    document.body.appendChild(el);
    window.__openedDemo = file && file.name;
    if (ctx.capabilities.includes('media')) {
      await ctx.media.setMetadata({ title: (file && file.name) || 'Demo', artist: BRAND });
      await ctx.media.setPlaybackState('playing');
      await ctx.media.setActionHandler('pause', async () => {
        await ctx.media.setPlaybackState('paused');
        if (ctx.capabilities.includes('dock')) await ctx.dock.disable();
      });
    }
    if (ctx.capabilities.includes('dock')) await ctx.dock.enable({ minSize: { width: 320, height: 80 } });
  });
});
`;

// The plugin's main (background) entry: implements its declared commands and does
// one-time storage/network setup. It never registers contributions.
export const PLUGIN_ENTRY = `
import { activate } from 'trove';
import { BRAND } from './shared.js';
activate(async (ctx) => {
  ctx.commands.handle('demo.tap', () => ctx.ui.toast('tap'));
  ctx.commands.handle('demo.sync', () => ctx.ui.toast(ctx.online ? 'synced' : 'offline'));
  ctx.commands.handle('demo.hang', () => { for (;;) {} });
  // Ask the HOST to run a command (gated per-command by the manifest allowlist).
  ctx.commands.handle('demo.runHostCommand', async () => {
    try { await ctx.commands.execute('demo.tap'); window.__hostCmd = 'ok'; }
    catch (e) { window.__hostCmd = 'error: ' + (e && e.message); }
  });
  ctx.commands.handle('demo.runUndeclared', async () => {
    try { await ctx.commands.execute('explorer.delete'); return 'ALLOWED'; }
    catch (e) { return 'REFUSED: ' + (e && e.message); }
  });
  ctx.commands.handle('demo.brand', () => BRAND);

  ctx.resources.text('data.txt').then((t) => { window.__resourceText = t; });

  if (ctx.storage && ctx.storage.plugin) {
    const db = ctx.storage.plugin.server;
    await db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
    await db.run('INSERT OR REPLACE INTO kv (k,v) VALUES (?,?)', 'installs', '1');
    ctx.commands.handle('demo.store', async () => {
      const row = await db.get('SELECT v FROM kv WHERE k = ?', 'installs');
      return row && row.v;
    });
    const cdb = ctx.storage.plugin.client;
    await cdb.exec('CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v TEXT)');
    await cdb.run('INSERT OR REPLACE INTO t (k,v) VALUES (?,?)', 'ping', 'pong');
    ctx.commands.handle('demo.storeClient', async () => {
      const row = await cdb.get('SELECT v FROM t WHERE k = ?', 'ping');
      return row && row.v;
    });
  }

  if (ctx.capabilities.includes('network')) {
    ctx.commands.handle('demo.net', async () => {
      const netcap = (ctx.manifest.capabilities || {}).network;
      const base = (netcap && netcap.endpoints && netcap.endpoints[0]) || '';
      const r = await ctx.net.fetch(base + 'api/capabilities');
      let blocked = 'NOT-BLOCKED';
      try { await ctx.net.fetch('https://evil.example.com/x'); } catch (e) { blocked = 'BLOCKED'; }
      return { status: r.status, ok: r.ok, blocked };
    });
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
    entry: 'src/index.js',
    capabilities: { storage: true, ui: true, commands: true },
    // Contributions are declared here and registered by the host before the plugin
    // boots. Each opener/indexer names the entry MODULE that implements it.
    contributes: {
      commands: [
        { id: 'demo.tap', title: 'Demo: Tap', offline: true },
        { id: 'demo.sync', title: 'Demo: Sync to cloud', offline: false },
        { id: 'demo.hang', title: 'Demo: (simulate hang)', offline: true },
        { id: 'demo.runHostCommand', title: 'Demo: Run a host command', offline: true },
        { id: 'demo.runUndeclared', title: 'Demo: Run an undeclared command', offline: true },
        { id: 'demo.brand', title: 'Demo: Brand', offline: true },
        { id: 'demo.store', title: 'Demo: Read store', offline: true },
        { id: 'demo.storeClient', title: 'Demo: Read client store', offline: true },
        { id: 'demo.net', title: 'Demo: Net', offline: false },
      ],
      openers: [
        { id: 'demo.player', title: 'Demo Player', match: { ext: ['.demo'] }, entry: 'src/openers/player.js', offline: true },
      ],
      statusItems: [{ id: 'demo.status', align: 'right', text: 'demo', offline: true }],
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
    ['src/index.js', strToU8(PLUGIN_ENTRY)],
    ['src/shared.js', strToU8(SHARED)],
    ['src/openers/player.js', strToU8(OPENER_ENTRY)],
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

// A multi-file package: entry under src/ importing a sibling module (relative) and
// the SDK as a bare `trove` specifier — exercises the import-map/blob module loader.
const MOD_INDEX = `
import { greeting } from './lib/util.js';
import { activate } from 'trove';
activate(async (ctx) => {
  ctx.commands.handle('mod.hello', () => greeting());
});
`;
const MOD_UTIL = `export const greeting = () => 'hello-from-module';`;

export function buildModulePackage() {
  const manifest = {
    id: 'com.trove.mod', name: 'Modular Demo', version: '1.0.0',
    entry: 'src/index.js', capabilities: { ui: true, commands: true },
    contributes: { commands: [{ id: 'mod.hello', title: 'Mod: Hello', offline: true }] },
  };
  const entries = {
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'src/index.js': strToU8(MOD_INDEX),
    'src/lib/util.js': strToU8(MOD_UTIL),
  };
  return { zip: zipSync(entries), manifest };
}

/** An assetlinks doc that vouches for `fingerprint` for `pluginId`. */
export function assetlinksFor(fingerprint, pluginId) {
  return { version: 1, keys: [{ fingerprint, plugins: [pluginId] }] };
}
