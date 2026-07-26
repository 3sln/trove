// Plugin offline-capability e2e: install the sandboxed demo plugin, confirm it
// announces a live manifest (so we know it's actually running), and verify that
// going offline flips its network-only feature to unavailable while its
// offline-capable feature stays available — and back again on reconnect.

import { chromium } from 'playwright-core';
import { createServer, configFromEnv } from '../../server/src/index.js';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { buildPackage, buildModulePackage, DEMO_ID, demoUri } from './pluginFixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm' };
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

async function assets(req) {
  const url = new URL(req.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const fp = path.join(DIST, path.normalize(rel));
  if (!fp.startsWith(DIST)) return null;
  try {
    const st = await fsp.stat(fp);
    if (st.isDirectory()) throw 0;
    return new Response(Readable.toWeb(fs.createReadStream(fp)), { headers: { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' } });
  } catch {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return new Response(await fsp.readFile(path.join(DIST, 'index.html')), { headers: { 'content-type': 'text/html' } });
    return null;
  }
}
async function toWeb(r) { const h = new Headers(); for (const [k, v] of Object.entries(r.headers)) if (v) h.set(k, v); const b = r.method !== 'GET' && r.method !== 'HEAD'; return new Request('http://localhost' + r.url, { method: r.method, headers: h, body: b ? Readable.toWeb(r) : undefined, duplex: 'half' }); }

// Every contribution is addressed by its URI, so a check names exactly one thing.
const availOf = (page, uri) => page.evaluate((cid) => {
  const p = window.__trove.platform;
  return p.commands.isAvailable(p.contributions.get(cid));
}, uri);
const exec = (page, uri, ...args) => page.evaluate(
  ([cid, a]) => window.__trove.platform.commands.execute(cid, ...a), [uri, args]);

async function main() {
  const srv = await createServer({ ...configFromEnv({ TROVE_STORAGE: 'memory' }), assets, startFlusher: false });
  // A file the demo plugin's sandboxed opener handles (exercises the viewer + dock).
  const demoFile = await srv.vfs.writeFile('track.demo', 'demo media', { contentType: 'application/x-demo' });
  const server = http.createServer(async (req, res) => { const wr = await srv.handle(await toWeb(req)); res.statusCode = wr.status; wr.headers.forEach((v, k) => res.setHeader(k, v)); if (wr.body) Readable.fromWeb(wr.body).pipe(res); else res.end(); });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  // A third-party service, on its own origin. The broker refuses to call the drive
  // itself, so "a declared endpoint works" has to be demonstrated against something
  // that is genuinely somewhere else — which is also the only shape a real plugin's
  // `network` capability has.
  const elsewhere = http.createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ hello: 'from elsewhere' }));
  });
  await new Promise((r) => elsewhere.listen(0, r));
  const partner = `http://127.0.0.1:${elsewhere.address().port}`;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('.shell');

  // Install the demo plugin package (zip bytes) and wait for its live manifest.
  // It declares the partner service as its one allowed endpoint — and the drive's own
  // origin as a second, to prove that declaring it buys nothing.
  const { zip } = await buildPackage({
    manifest: {
      capabilities: {
        storage: true, ui: true, opener: true, media: true, dock: true,
        // Scoped: exactly one host command is executable (plus the plugin's own).
        commands: { execute: ['workbench.view.home'] },
        network: { endpoints: [partner + '/', base + '/'] },
      },
    },
  });
  const b64 = Buffer.from(zip).toString('base64');
  await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const pkg = window.__trove.test.parsePackage(bytes);
    await window.__trove.test.install(pkg, {}); // grants default to all declared capabilities
  }, b64);
  await page.waitForFunction((id) => {
    const p = window.__trove.platform.plugins.list().find((x) => x.id === id);
    return p && p.responsive && (p.features || []).length >= 2;
  }, DEMO_ID, { timeout: 8000 });
  check('plugin announced a live manifest (is running)', true);

  // The demo declares `storage`, so it's account-scoped: installing uploads the full
  // package to the server (source of truth for cross-device sync + capability enforcement).
  const installed = await page.evaluate(async () => (await window.__trove.platform.api.installedPlugins()).plugins.map((p) => p.pluginId));
  check('account-scoped plugin uploaded to the server on install', installed.includes(DEMO_ID), installed.join(', '));

  // Cross-device sync: wipe this device's local copy, then re-run restore — it should
  // pull the package back down from the server and re-enable it.
  await page.evaluate(async (id) => {
    await window.__trove.platform.plugins.registry.remove(id);
    window.__trove.platform.plugins.plugins.get(id)?.iframe?.remove();
    window.__trove.platform.plugins.plugins.delete(id);
    await window.__trove.platform.plugins.restore();
  }, DEMO_ID);
  await page.waitForFunction((id) => {
    const p = window.__trove.platform.plugins.list().find((x) => x.id === id);
    return p && p.responsive;
  }, DEMO_ID, { timeout: 8000 });
  check('account plugin re-synced from the server on a fresh device', true);

  const features = await page.evaluate((id) => window.__trove.platform.plugins.list().find((x) => x.id === id).features, DEMO_ID);
  const tap = features.find((f) => f.name === 'tap');
  const sync = features.find((f) => f.name === 'sync');
  check('offline-capable feature is flagged', tap?.offline === true && sync?.offline === false, `tap.offline=${tap?.offline} sync.offline=${sync?.offline}`);
  check('every declared contribution is addressed by its URI', tap?.id === demoUri('tap'), String(tap?.id));

  // Online: both plugin commands are available.
  check('online: both plugin commands available', (await availOf(page, demoUri('tap'))) && (await availOf(page, demoUri('sync'))));

  // A plugin can ask the HOST to run a command (ctx.commands.execute → 'command:execute',
  // gated by the `commands` capability). demo.runHostCommand invokes demo.tap, whose
  // handler toasts — so a new toast proves the round-trip reached the host and back.
  await page.evaluate(() => window.__trove.platform.notifications.items.splice(0));
  await exec(page, demoUri('runHostCommand'));
  await page.waitForTimeout(400);
  const toasted = await page.evaluate(() => window.__trove.platform.notifications.items.some((n) => /tap/.test(n.message)));
  check('plugin can execute a host command (ctx.commands.execute)', toasted === true, String(toasted));

  // …but ONLY the commands its manifest lists. The allowlist is per-command, so a
  // plugin granted `workbench.view.home` can't reach `explorer.delete`.
  const undeclared = await exec(page, demoUri('runUndeclared'));
  check('a command outside the declared allowlist is refused', /^REFUSED/.test(String(undeclared)), String(undeclared));

  // Contributions come from the MANIFEST, so the host knows them without the plugin
  // registering anything at runtime — and the opener shares the plugin's module tree.
  const declared = await page.evaluate((uri) => {
    const o = window.__trove.platform.contributions.get(uri);
    return o ? { uri: o.uri, type: o.type, entry: o.entry, pluginId: o.pluginId } : null;
  }, demoUri('player'));
  check('opener is registered from the manifest with its entry module',
    declared?.type === 'opener' && declared?.entry === 'src/openers/player.js' && declared?.pluginId === DEMO_ID, JSON.stringify(declared));

  // src/shared.js is imported by BOTH the plugin entry and the opener entry.
  const brand = await exec(page, demoUri('brand'));
  check('plugin and opener share modules from one tree', brand === 'Trove', String(brand));

  // --- the other contribution types --------------------------------------------
  // A status slot: declared in the manifest, filled in over RPC, rendered as
  // SANITIZED html (the <b> survives; anything scriptable would not).
  await page.waitForFunction(() => [...document.querySelectorAll('.statusbar .seg')].some((e) => /demo ready/.test(e.textContent)), { timeout: 5000 });
  check('a declared status slot renders the html the plugin pushed', true);
  check('status html is sanitized to an inline allowlist', await page.evaluate(() =>
    [...document.querySelectorAll('.statusbar .seg')].some((e) => e.querySelector('b') && !e.querySelector('script'))));

  // A plugin can only drive slots it DECLARED — an undeclared name is refused.
  const badSlot = await exec(page, demoUri('badSlot'));
  check('driving an undeclared slot is refused', /^REFUSED/.test(String(badSlot)), String(badSlot));

  // A register: a context value slot, addressed by URI, readable from when-clauses.
  check('a declared register seeds the context with its default', await page.evaluate(
    (uri) => window.__trove.platform.context.get(uri) === false, demoUri('busy')));
  await exec(page, demoUri('setBusy'), true);
  await page.waitForFunction((uri) => window.__trove.platform.context.get(uri) === true, demoUri('busy'), { timeout: 4000 });
  check('the plugin drives its register, and when-clauses see it', await page.evaluate(
    (uri) => window.__trove.platform.context.evaluate(uri), demoUri('busy')));

  // A keymap: a JSON file in the package, its bindings folded into the one keymap.
  const keys = await page.evaluate(() => window.__trove.platform.keybindings.resolved().filter((b) => b.pluginId));
  check('a keymap file contributes bindings to the shared keymap',
    keys.some((b) => b.key === 'ctrl+alt+d' || b.key === 'meta+alt+d'), JSON.stringify(keys));
  check('keymap bindings resolve to the plugin\'s own commands by URI',
    keys.every((b) => b.command === demoUri('tap') || b.command === demoUri('brand')), JSON.stringify(keys.map((b) => b.command)));
  check('a keymap binding to a command the plugin may not run is dropped',
    keys.every((b) => !/explorer\.delete/.test(b.command)) && keys.length === 2, JSON.stringify(keys.map((b) => b.command)));

  // Brokered network: the declared endpoint succeeds; an undeclared host is blocked.
  const net = await exec(page, demoUri('net'));
  check('brokered fetch to a declared endpoint succeeds', net?.ok === true && net?.status === 200, JSON.stringify(net));
  check('fetch to an undeclared endpoint is blocked', net?.blocked === 'BLOCKED', JSON.stringify(net));
  check('the drive\'s own API is blocked even when declared', net?.drive === 'BLOCKED', JSON.stringify(net));

  // Plugin storage: the demo wrote to its private server-side SQLite db on activate;
  // read it back through a command to prove the round-trip.
  const stored = await exec(page, demoUri('store'));
  check('plugin server storage round-trips via SQLite', stored === '1', String(stored));

  // Client-side (wasm SQLite in the host, persisted to IndexedDB).
  const clientStored = await exec(page, demoUri('storeClient'));
  check('plugin client storage round-trips via wasm SQLite', clientStored === 'pong', String(clientStored));

  // Multi-file ESM package: entry under src/ imports a sibling module + the SDK as a
  // bare `trove` specifier. Proves the blob/import-map loader resolves them with no
  // bundler and no direct file fetch inside the sandbox.
  const mod = Buffer.from(buildModulePackage().zip).toString('base64');
  await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const pkg = window.__trove.test.parsePackage(bytes);
    await window.__trove.test.install(pkg, {});
  }, mod);
  await page.waitForFunction(
    (id) => window.__trove.platform.plugins.list().some((p) => p.id === id && p.status === 'active'),
    'trove.test/mod', { timeout: 8000 },
  );
  const modResult = await exec(page, 'trove+contrib:trove.test/mod/hello');
  check('multi-file ESM plugin loads & relative import resolves', modResult === 'hello-from-module', String(modResult));

  // Go offline — the host notifies the plugin, which re-announces.
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.waitForFunction((id) => {
    const p = window.__trove.platform.plugins.list().find((x) => x.id === id);
    return p?.manifest?.online === false;
  }, DEMO_ID, { timeout: 5000 });

  const tapOffline = await availOf(page, demoUri('tap'));
  const syncOffline = await availOf(page, demoUri('sync'));
  check('offline: offline-capable command stays available', tapOffline === true);
  check('offline: network-only command becomes unavailable', syncOffline === false);

  // Back online — the network-only command is available again.
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction((uri) => {
    const p = window.__trove.platform;
    return p.commands.isAvailable(p.contributions.get(uri));
  }, demoUri('sync'), { timeout: 5000 });
  check('reconnect: network-only command available again', true);

  // Helpers reaching into the demo plugin's live frames. The primary (background)
  // frame is record.frame; each open viewer runs in its OWN iframe, tracked in
  // record.frames. viewerFrame() returns the one viewer frame's DOM/placement state.
  const frameCount = () => page.evaluate((id) => window.__trove.platform.plugins.plugins.get(id).frames.size, DEMO_ID);
  const viewerFrame = () => page.evaluate((id) => {
    const r = window.__trove.platform.plugins.plugins.get(id);
    const frame = [...r.frames][0];
    if (!frame) return null;
    const f = frame.iframe;
    return { role: frame.role, sandbox: f.getAttribute('sandbox') || '', vis: f.style.visibility, w: parseFloat(f.style.width) || 0, z: f.style.zIndex, isPrimary: f === r.iframe };
  }, DEMO_ID);
  const viewerResponsive = () => page.evaluate(async (id) => {
    const r = window.__trove.platform.plugins.plugins.get(id);
    const frame = [...r.frames][0];
    if (!frame) return false;
    try { const m = await frame.channel.call('manifest', {}, { timeout: 2000 }); return m && m.name === 'demo'; } catch { return false; }
  }, DEMO_ID);

  // Open the .demo file → the opener mounts in its OWN sandboxed iframe, floated as a
  // fixed overlay over the .pv-host box (never re-parented — moving an <iframe> in the
  // DOM reloads it). The opener autoplays: sets the media session + enables dock.
  await page.evaluate(([node, uri]) => window.__trove.platform.workbench.openFile(node, uri), [demoFile, demoUri('player')]);
  await page.waitForSelector('.viewer.plugin-viewer .pv-host', { timeout: 4000 });
  await page.waitForFunction((id) => window.__trove.platform.plugins.plugins.get(id).frames.size === 1, DEMO_ID, { timeout: 5000 });
  check('viewer runs in its own iframe, separate from the background frame', await page.evaluate((id) => {
    const r = window.__trove.platform.plugins.plugins.get(id);
    const frame = [...r.frames][0];
    return frame && frame.role === 'viewer' && frame.iframe !== r.iframe;
  }, DEMO_ID));
  check('viewer frame is responsive after mount (not reloaded)', await viewerResponsive());
  // The loading overlay is dismissed once the opener finishes opening the file.
  await page.waitForFunction(() => {
    const s = document.querySelector('.viewer.plugin-viewer .pv-status');
    return s && getComputedStyle(s).display === 'none';
  }, { timeout: 4000 });
  check('viewer loading overlay clears once the opener is ready', true);
  const v0 = await viewerFrame();
  check('viewer iframe shown as a fixed overlay', v0 && v0.vis === 'visible' && v0.w > 0);
  check('viewer iframe is on an opaque origin (sandboxed)', v0 && v0.sandbox.includes('allow-scripts') && !v0.sandbox.includes('allow-same-origin'));

  // The opener drove the OS media session on open.
  await page.waitForFunction(() => navigator.mediaSession && navigator.mediaSession.metadata && navigator.mediaSession.metadata.title === 'track.demo', { timeout: 4000 });
  check('viewer drives the OS media session (mediaSession.metadata)', true);
  check('media playbackState reflects playing', await page.evaluate(() => navigator.mediaSession.playbackState === 'playing'));

  // Navigate away while "playing" → the viewer floats into the dock instead of
  // being torn down. The SAME viewer frame stays alive (still responsive).
  await page.evaluate(() => window.__trove.platform.workbench.showHome());
  await page.waitForFunction(() => {
    const d = document.querySelector('.viewer-dock');
    return d && getComputedStyle(d).display !== 'none';
  }, { timeout: 4000 });
  check('navigating away docks the viewer (floating frame)', true);
  check('dock removed the viewer host from the main area', await page.evaluate(() => document.querySelectorAll('.viewer.plugin-viewer').length === 0));
  check('docked frame is the same viewer frame, still one, still responsive', (await frameCount()) === 1 && (await viewerResponsive()));
  const vDock = await viewerFrame();
  check('docked frame visible over the dock body', vDock && vDock.vis === 'visible' && vDock.w > 0);

  // Expand from the dock re-adopts the SAME frame (playback preserved) — no new frame.
  await page.evaluate(() => document.querySelector('.viewer-dock .vd-expand').click());
  await page.waitForSelector('.viewer.plugin-viewer .pv-host', { timeout: 4000 });
  check('expanding re-adopts the same frame (no respawn)', (await frameCount()) === 1);
  check('expanding the dock hides the dock', await page.evaluate(() => getComputedStyle(document.querySelector('.viewer-dock')).display === 'none'));

  // Fire the OS 'pause' transport action into the viewer frame → the plugin disables
  // dock. Now navigating away just closes the viewer (no dock), destroying its frame.
  await page.evaluate((id) => {
    const r = window.__trove.platform.plugins.plugins.get(id);
    [...r.frames][0].channel.emit('media:action', { action: 'pause' });
  }, DEMO_ID);
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__trove.platform.workbench.showHome());
  await page.waitForFunction((id) => window.__trove.platform.plugins.plugins.get(id).frames.size === 0, DEMO_ID, { timeout: 4000 });
  check('with dock disabled, navigating away closes the viewer (frame destroyed)', await page.evaluate(() => {
    const d = document.querySelector('.viewer-dock');
    return !d || getComputedStyle(d).display === 'none';
  }));

  // Reopen (autoplay re-enables dock), dock, then the user closes the dock manually.
  await page.evaluate(([node, uri]) => window.__trove.platform.workbench.openFile(node, uri), [demoFile, demoUri('player')]);
  await page.waitForSelector('.viewer.plugin-viewer .pv-host', { timeout: 4000 });
  await page.waitForFunction(() => navigator.mediaSession.metadata && navigator.mediaSession.metadata.title === 'track.demo', { timeout: 4000 });
  await page.evaluate(() => window.__trove.platform.workbench.showHome());
  await page.waitForFunction(() => { const d = document.querySelector('.viewer-dock'); return d && getComputedStyle(d).display !== 'none'; }, { timeout: 4000 });
  await page.evaluate(() => document.querySelector('.viewer-dock .vd-close').click());
  await page.waitForFunction((id) => window.__trove.platform.plugins.plugins.get(id).frames.size === 0, DEMO_ID, { timeout: 4000 });
  check('user can manually close the dock (frame destroyed)', await page.evaluate(() => {
    const d = document.querySelector('.viewer-dock');
    return !d || getComputedStyle(d).display === 'none';
  }));
  check('background (primary) frame stayed responsive throughout', await page.evaluate(async (id) => {
    const r = window.__trove.platform.plugins.plugins.get(id);
    try { const m = await r.channel.call('manifest', {}, { timeout: 2000 }); return m && m.name === 'demo'; } catch { return false; }
  }, DEMO_ID));

  // Heartbeat (run last — it deliberately wedges the frame): with a short interval,
  // a plugin that stops answering manifest probes is detected as unresponsive (no
  // connectivity change involved) and its features become unavailable.
  await page.evaluate(() => window.__trove.platform.plugins.setHeartbeat(400));
  // Fire-and-forget: the command never returns (the frame is blocked), so its RPC
  // will eventually time out — swallow that rejection here.
  await page.evaluate((uri) => { window.__trove.platform.commands.execute(uri).catch(() => {}); }, demoUri('hang'));
  await page.waitForFunction((id) => {
    const p = window.__trove.platform.plugins.list().find((x) => x.id === id);
    return p && p.responsive === false;
  }, DEMO_ID, { timeout: 6000 });
  check('heartbeat marks a hung plugin unresponsive', true);
  check('hung plugin: even offline-capable command unavailable', (await availOf(page, demoUri('tap'))) === false);

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  server.close();
  elsewhere.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
