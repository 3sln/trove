// End-to-end smoke test: boot the real Trove server (in-memory backends) serving
// the built web app, drive it in headless Chromium, and assert the workbench
// renders and core flows work — listing, upload via the API surface, file
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
  const welcome = await vfs.writeFile('welcome.md',
    '# Welcome to Trove\n\nThis drive supports semantic search over your documents about sailing, cooking, and astronomy.\n\n'
    + 'There are no folders — documents like this one group things by linking them:\n\n'
    + '- [Sailing notes](trove:default/sailing.txt)\n',
    { contentType: 'text/markdown' });
  await vfs.writeFile('notes.txt', 'plain notes with no tags', { contentType: 'text/plain' });
  const sailing = await vfs.writeFile('sailing.txt', 'Trimming the mainsail and tacking upwind across the bay at dawn.', { contentType: 'text/plain' });
  // Tag two of them so the launcher's #tag/#property filters have something to match.
  await vfs.metadata.setContribution(welcome.id, 'user', { tags: { fav: 'yes', rating: '5' } });
  await vfs.metadata.setContribution(sailing.id, 'user', { tags: { fav: 'yes', deep: 'yes' } });

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
  // `window.__trove` is off in the shipped bundle — see createWorkbench's `debug`
  // option. `addInitScript` runs before any page script, which is how automation asks.
  await page.addInitScript(() => { window.__troveDebug = true; });
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
  check('launcher lists the collection\'s items', names.includes('welcome.md') && names.includes('sailing.txt'), names.join(', '));

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

  // Open a file from the launcher → the opener takes the full viewer panel (a
  // stacked panel over the base search), and the launcher is no longer shown.
  await page.locator('.launch-item', { hasText: 'welcome.md' }).first().click();
  await page.waitForSelector('.viewer-nav', { timeout: 3000 });
  await page.waitForSelector('.viewer.markdown .md', { timeout: 3000 });
  const text = await page.locator('.viewer.markdown .md').textContent();
  check('markdown renders as a document, not raw text', /Welcome to Trove/.test(text) && (await page.locator('.md-h1').count()) === 1);
  check('opener takes the full viewer panel', (await page.locator('.launcher').count()) === 0);

  // A trove: link navigates in-app — this is what replaced folders, so it has to work
  // from the rendered document, not just from the API.
  check('a trove: link renders as a link', (await page.locator('.md-trove').count()) >= 1);
  await page.locator('.md-trove').first().click();
  await page.waitForFunction(() => window.__trove.app.navigation.get().stack.some((p) => p.node?.name === 'sailing.txt'), { timeout: 4000 });
  check('following a trove: link opens the target item', true);

  // Backlinks: the info panel says what gathers this item up.
  await page.evaluate(() => window.__trove.platform.commands.execute('workbench.toggleInfoPanel'));
  // Wait on the DOM, not the store: the state lands a tick before the re-render.
  await page.waitForSelector('.ip-backlink', { timeout: 4000 }).catch(() => {});
  const back = await page.locator('.ip-backlink').allTextContents();
  check('backlinks show which document links here', back.some((t) => /welcome\.md/.test(t)), back.join(', '));
  await page.evaluate(() => window.__trove.platform.commands.execute('workbench.toggleInfoPanel'));
  // Pop back to welcome.md so the Back check below starts from one panel deep. Done
  // through the API: clicking Back here races the info-panel close re-render.
  await page.evaluate(() => window.__trove.app.navigation.back());
  await page.waitForFunction(() => window.__trove.app.navigation.get().activeFile?.name === 'welcome.md', { timeout: 3000 });

  // Back pops the stack → the launcher again.
  await page.locator('.viewer-nav .vn-back').click();
  await page.waitForSelector('.launcher .launch-input', { timeout: 3000 });
  check('back returns to the launcher', (await page.locator('.viewer-nav').count()) === 0);

  // Double-shift opens a modal search overlay; picking an item opens it (new stack).
  await page.keyboard.press('Shift');
  await page.keyboard.press('Shift');
  await page.waitForSelector('.search-modal .launch-input', { timeout: 2000 });
  check('double-shift opens modal search', (await page.locator('.search-modal').count()) === 1);
  await page.locator('.search-modal .launch-input').fill('welcome');
  await page.waitForTimeout(600);
  await page.locator('.search-modal .launch-item', { hasText: 'welcome.md' }).first().click();
  await page.waitForSelector('.viewer.markdown .md', { timeout: 3000 });
  check('modal search opens an item and closes', (await page.locator('.search-modal').count()) === 0 && (await page.locator('.viewer-nav').count()) === 1);

  await page.evaluate(() => window.__trove.platform.commands.execute('workbench.view.home'));

  // Semantic search in the launcher.
  await page.waitForSelector('.launch-input', { timeout: 3000 });
  await page.locator('.launch-input').fill('boat on the water');
  await page.waitForTimeout(700);
  const resultNames = await page.locator('.launch-item .name').allTextContents();
  check('semantic search returns results', resultNames.length > 0, resultNames.join(', '));
  await page.locator('.launch-clear').click();

  // Tag/property filters (drive-wide): `#fav` finds both tagged items, drops untagged.
  await page.locator('.launch-input').fill('#fav');
  await page.waitForTimeout(500);
  let filtered = await page.locator('.launch-item .name').allTextContents();
  check('#tag filter finds tagged files drive-wide', filtered.includes('welcome.md') && filtered.includes('sailing.txt') && !filtered.includes('notes.txt'), filtered.join(', '));
  await page.locator('.launch-input').fill('#deep');
  await page.waitForTimeout(500);
  filtered = await page.locator('.launch-item .name').allTextContents();
  check('#tag narrows to a single item', filtered.includes('sailing.txt') && !filtered.includes('welcome.md'), filtered.join(', '));
  await page.locator('.launch-input').fill('#rating:>=4');
  await page.waitForTimeout(500);
  filtered = await page.locator('.launch-item .name').allTextContents();
  check('#property comparison filter matches', filtered.includes('welcome.md'), filtered.join(', '));
  await page.locator('.launch-input').fill('#rating:>5');
  await page.waitForTimeout(500);
  filtered = await page.locator('.launch-item .name').allTextContents();
  check('#property comparison excludes non-matches', !filtered.includes('welcome.md'), filtered.join(', '));
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
