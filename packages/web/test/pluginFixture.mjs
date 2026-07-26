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
  ctx.commands.handle('tap', () => ctx.ui.toast('tap'));
  ctx.commands.handle('sync', () => ctx.ui.toast(ctx.online ? 'synced' : 'offline'));
  ctx.commands.handle('hang', () => { for (;;) {} });
  // Ask the HOST to run a command (gated per-command by the manifest allowlist).
  ctx.commands.handle('runHostCommand', async () => {
    try { await ctx.commands.execute('tap'); window.__hostCmd = 'ok'; }
    catch (e) { window.__hostCmd = 'error: ' + (e && e.message); }
  });
  ctx.commands.handle('runUndeclared', async () => {
    try { await ctx.commands.execute('explorer.delete'); return 'ALLOWED'; }
    catch (e) { return 'REFUSED: ' + (e && e.message); }
  });
  ctx.commands.handle('brand', () => BRAND);

  // Drive the DECLARED status slot and register — the plugin fills in what its
  // manifest declared; it can't add anything new.
  await ctx.ui.status('status').set('<b>demo</b> ready');
  await ctx.registers.set('busy', false);
  ctx.commands.handle('setBusy', (v) => ctx.registers.set('busy', !!v));
  ctx.commands.handle('badSlot', async () => {
    try { await ctx.ui.status('nope').set('x'); return 'ALLOWED'; }
    catch (e) { return 'REFUSED: ' + (e && e.message); }
  });

  ctx.resources.text('data.txt').then((t) => { window.__resourceText = t; });

  if (ctx.storage && ctx.storage.plugin) {
    const db = ctx.storage.plugin.server;
    await db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
    await db.run('INSERT OR REPLACE INTO kv (k,v) VALUES (?,?)', 'installs', '1');
    ctx.commands.handle('store', async () => {
      const row = await db.get('SELECT v FROM kv WHERE k = ?', 'installs');
      return row && row.v;
    });
    const cdb = ctx.storage.plugin.client;
    await cdb.exec('CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v TEXT)');
    await cdb.run('INSERT OR REPLACE INTO t (k,v) VALUES (?,?)', 'ping', 'pong');
    ctx.commands.handle('storeClient', async () => {
      const row = await cdb.get('SELECT v FROM t WHERE k = ?', 'ping');
      return row && row.v;
    });
  }

  if (ctx.capabilities.includes('network')) {
    ctx.commands.handle('net', async () => {
      const netcap = (ctx.manifest.capabilities || {}).network;
      const ends = (netcap && netcap.endpoints) || [];
      const r = await ctx.net.fetch(ends[0] + 'thing');
      let blocked = 'NOT-BLOCKED';
      try { await ctx.net.fetch('https://evil.example.com/x'); } catch (e) { blocked = 'BLOCKED'; }
      // The drive is declared too (endpoints[1]) — declaring it must not make it
      // reachable, or network would silently confer every other capability.
      let drive = 'NOT-BLOCKED';
      try { await ctx.net.fetch(ends[1] + 'api/capabilities'); } catch (e) { drive = 'BLOCKED'; }
      return { status: r.status, ok: r.ok, blocked, drive };
    });
  }
});
`;

// The keymap file the manifest's `keys` contribution points at — a plain JSON array,
// exactly like a VS Code keymap. `when` references the plugin's own `busy` register by
// its contribution URI, which is how registers are addressed everywhere.
export const KEYMAP = JSON.stringify([
  { key: 'mod+alt+d', command: 'tap' },
  { key: 'mod+alt+b', command: 'brand', when: 'trove+contrib:trove.test/demo/busy' },
  // A binding to a command this plugin was never granted — the host must drop it, or
  // a keymap would be a way around the per-command allowlist.
  { key: 'mod+alt+x', command: 'explorer.delete' },
  { command: 'tap' },        // no key    → skipped by the keymap parser
  { key: 'mod+alt+z' },      // no command → skipped by the keymap parser
]);

export const DEMO_DOMAIN = 'trove.test';
export const DEMO_NAME = 'demo';
export const DEMO_ID = `${DEMO_DOMAIN}/${DEMO_NAME}`;
/** The URI a demo contribution is addressed by. */
export const demoUri = (name) => `trove+contrib:${DEMO_ID}/${name}`;

export function baseManifest(overrides = {}) {
  return {
    domain: DEMO_DOMAIN,
    name: DEMO_NAME,
    displayName: 'Demo Plugin',
    version: '1.2.3',
    description: 'A demo plugin used in tests — a couple of commands, a status item, and a packaged resource.',
    author: 'Trove Tests',
    entry: 'src/index.js',
    capabilities: { storage: true, ui: true, commands: true },
    // ONE map of name -> contribution, each declaring its own type and options. The
    // host registers exactly this, before the plugin boots; the plugin only supplies
    // behaviour for what's here (and drives its slots), never adds to it.
    contributes: {
      tap: { type: 'command', title: 'Demo: Tap', offline: true },
      sync: { type: 'command', title: 'Demo: Sync to cloud', offline: false },
      hang: { type: 'command', title: 'Demo: (simulate hang)', offline: true },
      runHostCommand: { type: 'command', title: 'Demo: Run a host command', offline: true },
      runUndeclared: { type: 'command', title: 'Demo: Run an undeclared command', offline: true },
      brand: { type: 'command', title: 'Demo: Brand', offline: true },
      setBusy: { type: 'command', title: 'Demo: Set busy', offline: true },
      badSlot: { type: 'command', title: 'Demo: Drive an undeclared slot', offline: true },
      store: { type: 'command', title: 'Demo: Read store', offline: true },
      storeClient: { type: 'command', title: 'Demo: Read client store', offline: true },
      net: { type: 'command', title: 'Demo: Net', offline: false },
      player: { type: 'opener', title: 'Demo Player', match: { ext: ['.demo'] }, entry: 'src/openers/player.js', offline: true },
      status: { type: 'statusItem', slot: 'right', render: 'html', offline: true },
      busy: { type: 'register', default: false, description: 'Whether the demo is working' },
      keys: { type: 'keymap', path: 'keymaps/default.json' },
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
    ['keymaps/default.json', strToU8(KEYMAP)],
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
  ctx.commands.handle('hello', () => greeting());
});
`;
const MOD_UTIL = `export const greeting = () => 'hello-from-module';`;

export function buildModulePackage() {
  const manifest = {
    domain: 'trove.test', name: 'mod', displayName: 'Modular Demo', version: '1.0.0',
    entry: 'src/index.js', capabilities: { ui: true, commands: true },
    contributes: { hello: { type: 'command', title: 'Mod: Hello', offline: true } },
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
