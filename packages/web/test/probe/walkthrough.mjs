// A full in-browser walkthrough of the real app: boots the server + built client,
// drives the main user journeys end-to-end in headless Chromium, screenshots each
// step, and fails on any uncaught page error. This is the "does the whole thing
// actually still work" check that unit/e2e suites can't give you.
//
//   node packages/web/test/probe/walkthrough.mjs
// Screenshots land in packages/web/test/screens/.

import { boot, checker } from './harness.mjs';
import { buildPackage } from '../pluginFixture.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../screens');
fs.mkdirSync(OUT, { recursive: true });

const { check, done } = checker();
let step = 0;

const { page, errors, close, goto, vfs } = await boot({
  watchdogMs: 180_000, // a 16-step journey with a plugin install needs room
  seed: async (vfs) => {
    const docs = await vfs.mkdir('root', 'documents');
    const welcome = await vfs.writeFile('root', 'welcome.md',
      '# Welcome to Trove\n\nA self-hostable drive with semantic search, sandboxed plugins,\nand pluggable storage. This file is indexed for search.',
      { contentType: 'text/markdown' });
    const sailing = await vfs.writeFile(docs.id, 'sailing.txt',
      'Trimming the mainsail and tacking upwind across the bay at dawn. The keel bites and the boat heels over.',
      { contentType: 'text/plain' });
    await vfs.writeFile(docs.id, 'cooking.txt',
      'Braising short ribs low and slow with red wine, thyme and a mirepoix base.',
      { contentType: 'text/plain' });
    await vfs.writeFile('root', 'notes.txt', 'Plain notes with no tags.', { contentType: 'text/plain' });
    // Handled by the demo plugin's sandboxed opener (installed later in the journey).
    await vfs.writeFile('root', 'clip.demo', 'demo clip payload', { contentType: 'application/octet-stream' });
    // An .m4a matches BOTH the audiobook and audio openers → exercises the chooser.
    await vfs.metadata.create({ parentId: 'root', name: 'audiobook.m4a', kind: 'file', storageKey: 'k-ab', size: 1024, contentType: 'audio/mp4' });
    await vfs.metadata.setContribution(welcome.id, 'user', { tags: { fav: 'yes', rating: '5' } });
    await vfs.metadata.setContribution(sailing.id, 'user', { tags: { fav: 'yes', deep: 'yes' } });
  },
});

async function shot(name) {
  step++;
  await page.screenshot({ path: path.join(OUT, `${String(step).padStart(2, '0')}-${name}.png`) });
}

// ---- 1. Boot -----------------------------------------------------------------
await goto();
await page.waitForSelector('.launcher .launch-item', { timeout: 8000 });
check('app boots to the launcher with seeded content',
  (await page.locator('.launch-item .name').allTextContents()).includes('welcome.md'));
await shot('launcher-home');

// ---- 2. Browse into a folder -------------------------------------------------
await page.locator('.launch-item', { hasText: 'documents' }).first().click();
await page.waitForTimeout(500);
const inFolder = await page.locator('.launch-item .name').allTextContents();
check('browsing into a folder lists its children', inFolder.includes('sailing.txt') && inFolder.includes('cooking.txt'), inFolder.join(', '));
await shot('browse-folder');

// ---- 3. Open a file (text viewer) --------------------------------------------
await page.locator('.launch-item', { hasText: 'sailing.txt' }).first().click();
await page.waitForSelector('.viewer.text pre', { timeout: 5000 });
check('text opener renders file content', /mainsail/.test(await page.locator('.viewer.text pre').textContent()));
await shot('viewer-text');

// ---- 4. Info panel (tags + conversation) -------------------------------------
await page.locator('.viewer-nav .iconbtn[title="Details & comments"]').first().click();
await page.waitForSelector('.infopanel', { timeout: 3000 });
check('info panel opens with tags + conversation', (await page.locator('.infopanel').count()) === 1);
await shot('info-panel');

// Post a comment through the real UI.
await page.locator('.infopanel .composer textarea, .infopanel textarea').first().fill('Reviewed — looks good.');
await page.keyboard.press('Meta+Enter').catch(() => {});
await page.locator('.infopanel button', { hasText: /post|send|comment/i }).first().click().catch(() => {});
await page.waitForTimeout(700);
const commented = await page.evaluate(() => (window.__trove.app.social.state.sidecar?.comments || []).length);
check('a comment posts and appears in the sidecar', commented >= 1, `comments=${commented}`);
await shot('comment-posted');
await page.locator('.viewer-nav .iconbtn[title="Details & comments"]').first().click();

// ---- 5. Back to launcher -----------------------------------------------------
await page.locator('.viewer-nav .vn-back').first().click();
await page.waitForSelector('.launcher .launch-input', { timeout: 3000 });
check('back returns to the launcher', (await page.locator('.viewer-nav').count()) === 0);

// ---- 6. Semantic search ------------------------------------------------------
await page.evaluate(() => window.__trove.platform.workbench.showHome());
await page.waitForSelector('.launch-input', { timeout: 3000 });
await page.locator('.launch-input').fill('boat on the water at sunrise');
await page.waitForTimeout(1200);
const searchHits = await page.locator('.launch-item .name').allTextContents();
check('semantic search returns ranked results', searchHits.length > 0, searchHits.slice(0, 4).join(', '));
await shot('search-semantic');

// ---- 7. Tag filter -----------------------------------------------------------
await page.locator('.launch-input').fill('#fav');
await page.waitForTimeout(900);
const tagHits = await page.locator('.launch-item .name').allTextContents();
check('#tag filter finds tagged files drive-wide',
  tagHits.includes('welcome.md') && tagHits.includes('sailing.txt') && !tagHits.includes('notes.txt'), tagHits.join(', '));
await shot('search-tagfilter');
await page.locator('.launch-clear').click();

// ---- 8. Command palette ------------------------------------------------------
await page.keyboard.press('Control+Shift+KeyP');
await page.waitForSelector('.palette', { timeout: 3000 });
await page.locator('.palette input').fill('settings');
await page.waitForTimeout(300);
check('command palette filters commands',
  (await page.locator('.palette .opt .title').allTextContents()).some((t) => /settings/i.test(t)));
await shot('command-palette');
await page.keyboard.press('Escape');

// ---- 9. Quick open (files palette, via the QuickOpenAction) -------------------
await page.evaluate(() => window.__trove.platform.workbench.openPalette('files'));
await page.waitForSelector('.palette input', { timeout: 3000 });
await page.locator('.palette input').fill('cooking');
await page.waitForTimeout(900);
const qo = await page.evaluate(() => (window.__trove.app.search.state.paletteFiles || []).map((r) => r.node.name));
check('quick-open finds files by name', qo.includes('cooking.txt'), qo.join(', '));
await shot('quick-open');
await page.keyboard.press('Escape');

// ---- 10. Upload through the real API path ------------------------------------
await page.evaluate(async () => {
  const f = new File([new TextEncoder().encode('Uploaded during the walkthrough.')], 'uploaded.txt', { type: 'text/plain' });
  await window.__trove.app.platform.api.upload(f, { parentId: 'root' });
});
// Navigate the explorer back to the drive root (we browsed into documents earlier),
// so the browse list shows where the upload landed.
await page.evaluate(() => window.__trove.platform.workbench.showHome());
await page.evaluate(async () => {
  const { NavigateAction } = window.__trove.test;
  if (NavigateAction) await window.__trove.app.engine.dispatch(new NavigateAction('/'));
});
await page.waitForTimeout(1000);
const afterUpload = await page.locator('.launch-item .name').allTextContents();
check('an uploaded file appears in the drive', afterUpload.includes('uploaded.txt'), afterUpload.join(', '));
await shot('after-upload');

// ---- 11. Opener chooser (two openers match .m4a) -----------------------------
await page.locator('.launch-item', { hasText: 'audiobook.m4a' }).first().click();
await page.waitForSelector('.opener-chooser', { timeout: 4000 });
const openerNames = (await page.locator('.opener-opt .oo-title').allTextContents()).join(', ');
check('opener chooser appears when several viewers match', /Audiobook/i.test(openerNames) && /Audio Player/i.test(openerNames), openerNames);
await shot('opener-chooser');
await page.locator('.opener-opt', { hasText: 'Audio Player' }).first().click();
await page.locator('.opener-remember input').check();
await page.locator('.opener-chooser .btn.primary', { hasText: 'Open' }).click();
await page.waitForTimeout(700);
check('choosing an opener remembers it for the type',
  await page.evaluate(() => (window.__trove.platform.settings.get('openers.associations') || {})['.m4a'] === 'core.audio'));
await shot('opener-chosen');

// ---- 12. Settings (incl. the Default Openers section) ------------------------
await page.evaluate(() => window.__trove.platform.workbench.setActivity('settings'));
await page.waitForSelector('.settings', { timeout: 3000 });
const hasOpenerRow = await page.locator('.settings .group', { hasText: 'Default Openers' }).locator('.setting', { hasText: '.m4a' }).count();
check('settings lists the saved default opener', hasOpenerRow >= 1);
await shot('settings');

// ---- 13. Install the sandboxed demo plugin -----------------------------------
// Declare the capabilities the demo's opener/dock/media path needs (the fixture's
// default manifest only asks for storage/ui/commands).
const { zip } = await buildPackage({
  manifest: { capabilities: { storage: true, ui: true, commands: true, opener: true, media: true, dock: true } },
});
const b64 = Buffer.from(zip).toString('base64');
await page.evaluate(async (data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const pkg = window.__trove.test.parsePackage(bytes);
  await window.__trove.test.install(pkg, {});
}, b64);
await page.waitForFunction(() => window.__trove.platform.plugins.list().some((p) => p.status === 'active'), { timeout: 12000 });
await page.evaluate(() => window.__trove.platform.workbench.setActivity('plugins'));
await page.waitForTimeout(600);
check('sandboxed plugin installs and reports active',
  await page.evaluate(() => window.__trove.platform.plugins.list().some((p) => p.status === 'active' && p.responsive)));
await shot('plugins-installed');

// ---- 14. Plugin viewer + dock (PiP) ------------------------------------------
// clip.demo is handled by the demo plugin's opener, which runs in its OWN sandboxed
// iframe and opts into the floating dock.
await page.evaluate(() => window.__trove.platform.workbench.showHome());
await page.waitForTimeout(800);
await page.locator('.launch-item', { hasText: 'clip.demo' }).first().click({ timeout: 10000 });
// Wait for the viewer's OWN iframe (the plugin already has its background frame), so
// this doesn't race the sandbox handshake.
const gotViewerFrame = await page.waitForFunction(() => document.querySelectorAll('iframe').length >= 2, { timeout: 15000 })
  .then(() => true).catch(() => false);
const viewerFrames = await page.evaluate(() => document.querySelectorAll('iframe').length);
check('plugin opener mounts in its own sandboxed iframe', gotViewerFrame && viewerFrames >= 2, `iframes=${viewerFrames}`);
await shot('plugin-viewer');

// Navigate away → the viewer docks as a floating mini-player.
await page.evaluate(() => window.__trove.platform.workbench.showHome());
const dockVisible = await page.waitForFunction(() => {
  const el = document.querySelector('.viewer-dock');
  return !!el && el.style.display !== 'none';
}, { timeout: 10000 }).then(() => true).catch(() => false);
check('navigating away docks the viewer (PiP)', dockVisible === true, `docked=${dockVisible}`);
await shot('plugin-docked');

// Close the dock.
await page.evaluate(() => document.querySelector('.viewer-dock .vd-close')?.click());
await page.waitForTimeout(600);
check('the dock can be dismissed',
  await page.evaluate(() => { const el = document.querySelector('.viewer-dock'); return !el || el.style.display === 'none'; }));

// ---- 15. Uninstall the plugin ------------------------------------------------
await page.evaluate(async () => {
  const id = window.__trove.platform.plugins.list()[0]?.id;
  if (id) await window.__trove.platform.plugins.uninstall(id);
});
await page.waitForTimeout(900);
check('plugin uninstalls cleanly',
  await page.evaluate(() => window.__trove.platform.plugins.list().length === 0));
await shot('plugins-empty');

// ---- 16. No uncaught errors anywhere in the journey --------------------------
const fatal = errors.filter((e) => /pageerror/.test(e));
check('no uncaught page errors across the whole walkthrough', fatal.length === 0, fatal.slice(0, 3).join(' | '));

console.log(`\nScreenshots → ${OUT}`);
done();
await close();
