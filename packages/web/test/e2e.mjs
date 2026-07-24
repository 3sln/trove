// End-to-end smoke test: boot the real Trove server (in-memory backends) serving
// the built web app, drive it in headless Chromium, and assert the workbench
// renders and core flows work — folder creation, upload via the API surface, file
// opening, semantic search, and loading the sandboxed demo plugin. Also captures
// a screenshot for a visual sanity check.

import { chromium } from 'playwright-core';
import { createServer, configFromEnv } from '../../server/src/index.js';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { buildPackage } from './pluginFixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm' };

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

async function staticAssets(req) {
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
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      return new Response(await fsp.readFile(path.join(DIST, 'index.html')), { headers: { 'content-type': 'text/html' } });
    }
    return null;
  }
}

async function toWeb(nodeReq) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) if (v) headers.set(k, Array.isArray(v) ? v.join(',') : v);
  const hasBody = nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD';
  return new Request(`http://localhost${nodeReq.url}`, { method: nodeReq.method, headers, body: hasBody ? Readable.toWeb(nodeReq) : undefined, duplex: 'half' });
}

async function main() {
  const { handle, vfs } = await createServer({ ...configFromEnv({ TROVE_STORAGE: 'memory' }), assets: staticAssets });
  // Seed some content so search/open have something to work with.
  await vfs.writeFile('root', 'welcome.md', '# Welcome to Trove\nThis drive supports semantic search over your documents about sailing, cooking, and astronomy.', { contentType: 'text/markdown' });
  const docs = await vfs.mkdir('root', 'documents');
  await vfs.writeFile(docs.id, 'sailing.txt', 'Trimming the mainsail and tacking upwind across the bay at dawn.', { contentType: 'text/plain' });

  const server = http.createServer(async (req, res) => {
    const webRes = await handle(await toWeb(req));
    res.statusCode = webRes.status;
    webRes.headers.forEach((v, k) => res.setHeader(k, v));
    if (webRes.body) Readable.fromWeb(webRes.body).pipe(res);
    else res.end();
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('.shell', { timeout: 5000 });
  check('workbench shell renders', await page.locator('.shell').count() === 1);
  check('activity bar present', await page.locator('.activitybar .item').count() >= 1);

  // The launcher (main-panel home) browses the seeded content.
  await page.waitForSelector('.launcher .launch-item', { timeout: 5000 });
  const names = await page.locator('.launch-item .name').allTextContents();
  check('launcher browses seeded files', names.includes('welcome.md') && names.includes('documents'), names.join(', '));

  // `!` in the launcher switches to command execution.
  await page.locator('.launch-input').fill('!settings');
  await page.waitForTimeout(150);
  const cmdNames = await page.locator('.launch-item .name').allTextContents();
  check('launcher ! runs commands', cmdNames.some((t) => /settings/i.test(t)), cmdNames.slice(0, 5).join(', '));
  await page.locator('.launch-clear').click();

  // Command palette overlay still opens and filters.
  await page.keyboard.press('Control+Shift+KeyP');
  await page.waitForSelector('.palette', { timeout: 3000 });
  await page.locator('.palette input').fill('settings');
  const hasSettingsCmd = (await page.locator('.palette .opt .title').allTextContents()).some((t) => /settings/i.test(t));
  check('command palette filters commands', hasSettingsCmd);
  await page.keyboard.press('Escape');

  // Open a file from the launcher → opener renders as a split beside the launcher.
  await page.locator('.launch-item', { hasText: 'welcome.md' }).first().click();
  await page.waitForSelector('.viewer.text pre', { timeout: 3000 });
  const text = await page.locator('.viewer.text pre').textContent();
  check('text opener shows content', /Welcome to Trove/.test(text));
  check('opener opens split beside the launcher',
    (await page.locator('.workspace.split .ws-launcher .launcher').count()) === 1 &&
    (await page.locator('.workspace.split .ws-preview .viewer').count()) === 1);

  // Swap split → modal, then back (last choice persists as the default).
  await page.locator('.preview-controls .pc-btn').first().click();
  await page.waitForSelector('.workspace.modal .preview-modal .viewer', { timeout: 2000 });
  check('swap to modal shows the opener over the launcher', (await page.locator('.preview-modal').count()) === 1);
  await page.locator('.preview-controls .pc-btn').first().click();
  await page.waitForSelector('.workspace.split', { timeout: 2000 });
  check('swap back to split', (await page.locator('.workspace.split').count()) === 1);

  await page.evaluate(() => window.__trove.platform.workbench.showHome());

  // Semantic search in the launcher.
  await page.waitForSelector('.launch-input', { timeout: 3000 });
  await page.locator('.launch-input').fill('boat on the water');
  await page.waitForTimeout(700);
  const resultNames = await page.locator('.launch-item .name').allTextContents();
  check('semantic search returns results', resultNames.length > 0, resultNames.join(', '));
  await page.locator('.launch-clear').click();

  // Plugins: install the sandboxed demo plugin from a package (zip bytes), the
  // same path a user's ZIP upload takes — parse, review-then-install with grants.
  const { zip } = await buildPackage();
  const b64 = Buffer.from(zip).toString('base64');
  await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const pkg = window.__trove.test.parsePackage(bytes);
    await window.__trove.test.install(pkg, {}); // grants default to all declared capabilities
  }, b64);
  await page.waitForFunction(
    () => window.__trove.platform.plugins.list().some((p) => p.status === 'active'),
    { timeout: 8000 },
  );
  check('sandboxed plugin package installs & activates', true);

  await page.screenshot({ path: path.join(__dirname, 'screenshot.png'), fullPage: false });
  check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
