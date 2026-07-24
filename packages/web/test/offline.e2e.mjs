// Offline-mode e2e: register the SW, pin a file, go offline, and verify the file
// still opens (from cache), local search finds it, and a comment written offline
// is queued and then synced when the connection returns.

import { chromium } from 'playwright-core';
import { createServer, configFromEnv } from '../../server/src/index.js';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
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

async function main() {
  const srv = await createServer({ ...configFromEnv({ TROVE_STORAGE: 'memory' }), assets, startFlusher: false });
  await srv.vfs.writeFile('root', 'expedition.md', '# Antarctic Expedition\nNotes on the crossing: pack ice, penguins, and the long polar night.', { contentType: 'text/markdown' });

  const server = http.createServer(async (req, res) => { const wr = await srv.handle(await toWeb(req)); res.statusCode = wr.status; wr.headers.forEach((v, k) => res.setHeader(k, v)); if (wr.body) Readable.fromWeb(wr.body).pipe(res); else res.end(); });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const context = await browser.newPage();
  const page = context;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('.launch-item');
  // Wait for the service worker to control the page.
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, { timeout: 8000 }).catch(() => {});
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  if (!controlled) { await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('.launch-item'); }
  check('service worker controls the page', await page.evaluate(() => !!navigator.serviceWorker.controller));

  // Pin the file (make available offline).
  await page.evaluate(async () => {
    const app = window.__trove.app;
    const node = app.explorer.state.items.find((i) => i.name === 'expedition.md');
    await app.offline.pin(node);
  });
  await page.waitForFunction(() => window.__trove.app.offline.state.pins.length === 1, { timeout: 5000 });
  check('file pinned for offline', await page.evaluate(() => window.__trove.app.offline.isPinned(window.__trove.app.explorer.state.items.find((i) => i.name === 'expedition.md').id)));

  // Go offline.
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.waitForFunction(() => window.__trove.app.offline.state.online === false);
  check('offline state detected', true);

  // Open the pinned file offline — bytes come from the cache via the SW.
  const text = await page.evaluate(async () => {
    const app = window.__trove.app;
    const node = app.explorer.state.items.find((i) => i.name === 'expedition.md');
    return app.platform.api.readText(node.id);
  });
  check('pinned file opens offline', /Antarctic Expedition/.test(text), text.slice(0, 30));

  // Offline search finds the pinned file (semantic-ish + lexical).
  const found = await page.evaluate(async () => {
    const r = await window.__trove.app.offline.searchOffline('south pole penguins');
    return r.map((x) => x.node.name);
  });
  check('offline search finds pinned content', found.includes('expedition.md'), found.join(','));

  // Comment offline → queued.
  await page.evaluate(async () => {
    const app = window.__trove.app;
    const node = app.explorer.state.items.find((i) => i.name === 'expedition.md');
    await app.social.loadSidecar(node.id);
    await app.social.comment('Reviewing this offline — looks great!');
  });
  await page.waitForFunction(() => window.__trove.app.offline.state.queued === 1, { timeout: 4000 });
  check('offline comment is queued', true);

  // Back online → queue flushes, comment reaches the server.
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => window.__trove.app.offline.state.queued === 0, { timeout: 6000 });
  const serverHasComment = await page.evaluate(async () => {
    const app = window.__trove.app;
    const node = app.explorer.state.items.find((i) => i.name === 'expedition.md');
    const view = await app.platform.api.sidecar(node.id);
    return view.commentCount;
  });
  check('queued comment synced on reconnect', serverHasComment === 1, `commentCount=${serverHasComment}`);

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
