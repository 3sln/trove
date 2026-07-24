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
import { buildPackage, buildModulePackage } from './pluginFixture.mjs';

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

const availOf = (page, id) => page.evaluate((cid) => {
  const p = window.__trove.platform;
  return p.commands.isAvailable(p.contributions.commands.get(cid));
}, id);

async function main() {
  const srv = await createServer({ ...configFromEnv({ TROVE_STORAGE: 'memory' }), assets, startFlusher: false });
  // A file the demo plugin's sandboxed opener handles (exercises the viewer + dock).
  const demoFile = await srv.vfs.writeFile('root', 'track.demo', 'demo media', { contentType: 'application/x-demo' });
  const server = http.createServer(async (req, res) => { const wr = await srv.handle(await toWeb(req)); res.statusCode = wr.status; wr.headers.forEach((v, k) => res.setHeader(k, v)); if (wr.body) Readable.fromWeb(wr.body).pipe(res); else res.end(); });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('.shell');

  // Install the demo plugin package (zip bytes) and wait for its live manifest.
  // Declare this origin as the plugin's one allowed network endpoint so the
  // brokered-fetch enforcement can be exercised below.
  const { zip } = await buildPackage({
    manifest: { capabilities: { storage: true, ui: true, commands: true, opener: true, media: true, dock: true, network: { endpoints: [base + '/'] } } },
  });
  const b64 = Buffer.from(zip).toString('base64');
  await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const pkg = window.__trove.test.parsePackage(bytes);
    await window.__trove.test.install(pkg, {}); // grants default to all declared capabilities
  }, b64);
  await page.waitForFunction(() => {
    const p = window.__trove.platform.plugins.list().find((x) => x.id === 'com.trove.demo');
    return p && p.responsive && (p.features || []).length >= 2;
  }, { timeout: 8000 });
  check('plugin announced a live manifest (is running)', true);

  const features = await page.evaluate(() => window.__trove.platform.plugins.list().find((x) => x.id === 'com.trove.demo').features);
  const tap = features.find((f) => f.id === 'demo.tap');
  const sync = features.find((f) => f.id === 'demo.sync');
  check('offline-capable feature is flagged', tap?.offline === true && sync?.offline === false, `tap.offline=${tap?.offline} sync.offline=${sync?.offline}`);

  // Online: both plugin commands are available.
  check('online: both plugin commands available', (await availOf(page, 'demo.tap')) && (await availOf(page, 'demo.sync')));

  // Brokered network: the declared endpoint succeeds; an undeclared host is blocked.
  const net = await page.evaluate(() => window.__trove.platform.commands.execute('demo.net'));
  check('brokered fetch to a declared endpoint succeeds', net?.ok === true && net?.status === 200, JSON.stringify(net));
  check('fetch to an undeclared endpoint is blocked', net?.blocked === 'BLOCKED', JSON.stringify(net));

  // Plugin storage: the demo wrote to its private server-side SQLite db on activate;
  // read it back through a command to prove the round-trip.
  const stored = await page.evaluate(() => window.__trove.platform.commands.execute('demo.store'));
  check('plugin server storage round-trips via SQLite', stored === '1', String(stored));

  // Client-side (wasm SQLite in the host, persisted to IndexedDB).
  const clientStored = await page.evaluate(() => window.__trove.platform.commands.execute('demo.storeClient'));
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
    () => window.__trove.platform.plugins.list().some((p) => p.id === 'com.trove.mod' && p.status === 'active'),
    { timeout: 8000 },
  );
  const modResult = await page.evaluate(() => window.__trove.platform.commands.execute('mod.hello'));
  check('multi-file ESM plugin loads & relative import resolves', modResult === 'hello-from-module', String(modResult));

  // Go offline — the host notifies the plugin, which re-announces.
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.waitForFunction(() => {
    const p = window.__trove.platform.plugins.list().find((x) => x.id === 'com.trove.demo');
    return p?.manifest?.online === false;
  }, { timeout: 5000 });

  const tapOffline = await availOf(page, 'demo.tap');
  const syncOffline = await availOf(page, 'demo.sync');
  check('offline: offline-capable command stays available', tapOffline === true);
  check('offline: network-only command becomes unavailable', syncOffline === false);

  // Back online — the network-only command is available again.
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(async () => {
    const p = window.__trove.platform;
    return p.commands.isAvailable(p.contributions.commands.get('demo.sync'));
  }, { timeout: 5000 });
  check('reconnect: network-only command available again', true);

  // Open the .demo file → the plugin's opener mounts as a sandboxed viewer. The
  // iframe is a fixed overlay floating over the .pv-host box (it is never re-parented
  // — moving an <iframe> in the DOM would reload it and kill the plugin).
  await page.evaluate((node) => window.__trove.platform.workbench.openFile(node, 'demo.player'), demoFile);
  await page.waitForSelector('.viewer.plugin-viewer .pv-host', { timeout: 4000 });
  // The demo plugin frame stays responsive after mount (it wasn't reloaded).
  await page.waitForFunction(async () => {
    const r = window.__trove.platform.plugins.plugins.get('com.trove.demo');
    try { const m = await r.channel.call('manifest', {}, { timeout: 2000 }); return m && m.id === 'com.trove.demo'; } catch { return false; }
  }, { timeout: 5000 });
  check('plugin opener mounts a still-responsive sandboxed viewer (no reload)', true);
  const vis = () => page.evaluate(() => {
    const r = window.__trove.platform.plugins.plugins.get('com.trove.demo');
    const f = r && r.iframe;
    return f ? { sandbox: f.getAttribute('sandbox') || '', vis: f.style.visibility, w: parseFloat(f.style.width) || 0, z: f.style.zIndex } : null;
  });
  const v0 = await vis();
  check('viewer iframe shown as a fixed overlay', v0 && v0.vis === 'visible' && v0.w > 0);
  check('viewer iframe is on an opaque origin (sandboxed)', v0 && v0.sandbox.includes('allow-scripts') && !v0.sandbox.includes('allow-same-origin'));

  // Drive playback: the plugin sets the OS media session + enables dock mode.
  await page.evaluate(() => window.__trove.platform.commands.execute('demo.play'));
  await page.waitForFunction(() => navigator.mediaSession && navigator.mediaSession.metadata && navigator.mediaSession.metadata.title === 'track.demo', { timeout: 4000 });
  check('viewer drives the OS media session (mediaSession.metadata)', true);
  check('media playbackState reflects playing', await page.evaluate(() => navigator.mediaSession.playbackState === 'playing'));

  // Navigate away while "playing" → the viewer floats into the dock instead of
  // being torn down. The SAME iframe stays alive (still responsive).
  await page.evaluate(() => window.__trove.platform.workbench.showHome());
  await page.waitForFunction(() => {
    const d = document.querySelector('.viewer-dock');
    return d && getComputedStyle(d).display !== 'none';
  }, { timeout: 4000 });
  check('navigating away docks the viewer (floating frame)', true);
  check('dock removed the viewer host from the main area', await page.evaluate(() => document.querySelectorAll('.viewer.plugin-viewer').length === 0));
  const vDock = await vis();
  check('docked frame is the same iframe, still visible', vDock && vDock.vis === 'visible' && vDock.w > 0);
  check('docked frame stayed responsive (never reloaded)', await page.evaluate(async () => {
    const r = window.__trove.platform.plugins.plugins.get('com.trove.demo');
    try { const m = await r.channel.call('manifest', {}, { timeout: 2000 }); return m && m.id === 'com.trove.demo'; } catch { return false; }
  }));

  // Expand from the dock reopens the full viewer.
  await page.evaluate(() => document.querySelector('.viewer-dock .vd-expand').click());
  await page.waitForSelector('.viewer.plugin-viewer .pv-host', { timeout: 4000 });
  check('expanding the dock reopens the full viewer', await page.evaluate(() => getComputedStyle(document.querySelector('.viewer-dock')).display === 'none'));

  // Disabling dock (e.g. playback stopped) means navigating away just closes it.
  await page.evaluate(() => window.__trove.platform.commands.execute('demo.stop'));
  await page.evaluate(() => window.__trove.platform.workbench.showHome());
  await page.waitForTimeout(200);
  check('with dock disabled, navigating away does not dock', await page.evaluate(() => {
    const d = document.querySelector('.viewer-dock');
    return !d || getComputedStyle(d).display === 'none';
  }));

  // Reopen, dock, then user closes the dock manually.
  await page.evaluate(() => window.__trove.platform.commands.execute('demo.play'));
  await page.evaluate((node) => window.__trove.platform.workbench.openFile(node, 'demo.player'), demoFile);
  await page.waitForSelector('.viewer.plugin-viewer .pv-host', { timeout: 4000 });
  await page.evaluate(() => window.__trove.platform.workbench.showHome());
  await page.waitForFunction(() => { const d = document.querySelector('.viewer-dock'); return d && getComputedStyle(d).display !== 'none'; }, { timeout: 4000 });
  await page.evaluate(() => document.querySelector('.viewer-dock .vd-close').click());
  await page.waitForFunction(() => { const d = document.querySelector('.viewer-dock'); return !d || getComputedStyle(d).display === 'none'; }, { timeout: 4000 });
  check('user can manually close the dock', true);
  check('closing the dock hides the iframe', await page.evaluate(() => {
    const r = window.__trove.platform.plugins.plugins.get('com.trove.demo');
    return r.iframe.style.visibility === 'hidden';
  }));

  // Heartbeat (run last — it deliberately wedges the frame): with a short interval,
  // a plugin that stops answering manifest probes is detected as unresponsive (no
  // connectivity change involved) and its features become unavailable.
  await page.evaluate(() => window.__trove.platform.plugins.setHeartbeat(400));
  // Fire-and-forget: the command never returns (the frame is blocked), so its RPC
  // will eventually time out — swallow that rejection here.
  await page.evaluate(() => { window.__trove.platform.commands.execute('demo.hang').catch(() => {}); });
  await page.waitForFunction(() => {
    const p = window.__trove.platform.plugins.list().find((x) => x.id === 'com.trove.demo');
    return p && p.responsive === false;
  }, { timeout: 6000 });
  check('heartbeat marks a hung plugin unresponsive', true);
  check('hung plugin: even offline-capable command unavailable', (await availOf(page, 'demo.tap')) === false);

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
