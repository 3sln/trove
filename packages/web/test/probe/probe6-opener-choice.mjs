// Probe: opener conflict resolution — a PLUGIN opener competing with a built-in.
//
// That pairing is the whole reason the chooser exists, and it is the one that survives:
// every built-in either claims a type alone or ships a default association for it (`.md`
// opens as a document, deliberately). So the honest test installs a plugin whose opener
// overlaps `core.text`, which is also what a richer third-party viewer will do in
// practice.
//
// Opening should prompt; "Always use this" should remember the choice; a later open
// should skip the prompt; the viewer nav should offer a switch; and Settings should
// list + let you forget the association.

import { boot, checker } from './harness.mjs';
import { buildPackage } from '../pluginFixture.mjs';

const { check, done } = checker();

const { page, close, goto } = await boot({
  watchdogMs: 90_000,
  seed: async (vfs) => {
    // `text/plain` so `core.text` claims them by mime while the plugin claims them by
    // extension — two openers, and no association shipped for `.demo`.
    await vfs.writeFile('clip.demo', 'one', { contentType: 'text/plain' });
    await vfs.writeFile('clip2.demo', 'two', { contentType: 'text/plain' });
  },
});

await goto();
await page.waitForSelector('.launcher .launch-item', { timeout: 5000 });

const { zip } = await buildPackage({
  manifest: { capabilities: { storage: true, ui: true, commands: true, opener: true } },
});
await page.evaluate(async (data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  await window.__trove.test.install(window.__trove.test.parsePackage(bytes), {});
}, Buffer.from(zip).toString('base64'));
await page.waitForFunction(() => window.__trove.platform.plugins.list().some((p) => p.status === 'active'), { timeout: 20000 });
const PLUGIN_OPENER = await page.evaluate(() =>
  window.__trove.platform.contributions.ofType('opener').find((o) => o.pluginId)?.id);
check('a plugin opener is installed alongside the built-ins', !!PLUGIN_OPENER, String(PLUGIN_OPENER));

const assoc = () => page.evaluate(() => window.__trove.platform.settings.get('openers.associations') || {});
// The panel stack lives in the workbench's NavigationService sub-service.
const topOpener = () => page.evaluate(() => {
  const s = window.__trove.platform.workbench.nav.state.stack;
  const t = s[s.length - 1];
  return t && t.kind === 'file' ? t.openerId : null;
});

// 1. Open the first .demo → chooser appears with both openers.
await page.locator('.launch-item', { hasText: 'clip.demo' }).first().click();
await page.waitForSelector('.opener-chooser', { timeout: 3000 });
const optText = (await page.locator('.opener-opt .oo-title').allTextContents()).join(', ');
check('chooser lists the plugin viewer and the built-in', /Demo Player/i.test(optText) && /Text Viewer/i.test(optText), optText);

// 2. Pick "Text Viewer", check "Always use", Open.
await page.locator('.opener-opt', { hasText: 'Text Viewer' }).first().click();
await page.locator('.opener-remember input').check();
await page.locator('.opener-chooser .btn.primary', { hasText: 'Open' }).click();
await page.waitForSelector('.viewer', { timeout: 3000 });
check('opened with the chosen opener (core.text)', (await topOpener()) === 'core.text', String(await topOpener()));
check('choice remembered for .demo', (await assoc())['.demo'] === 'core.text', JSON.stringify(await assoc()));

// 3. Back, open the SECOND .demo → no prompt, opens directly with the remembered opener.
await page.locator('.viewer-nav .vn-back').first().click();
await page.waitForSelector('.launch-input', { timeout: 3000 });
await page.locator('.launch-item', { hasText: 'clip2.demo' }).first().click();
await page.waitForSelector('.viewer', { timeout: 3000 });
check('second open skips the prompt (remembered)', (await page.locator('.opener-chooser').count()) === 0 && (await topOpener()) === 'core.text');

// 4. The viewer nav offers "Open with…"; clicking reopens the chooser.
const switchBtn = page.locator('.viewer-nav .vn-actions .iconbtn[title="Open with…"]');
check('viewer nav shows an "Open with…" switch', (await switchBtn.count()) >= 1);
await switchBtn.first().click();
await page.waitForSelector('.opener-chooser', { timeout: 3000 });
// Switch to the plugin's viewer (one-off: leave "Always use" unchecked).
await page.locator('.opener-opt', { hasText: 'Demo Player' }).first().click();
await page.locator('.opener-chooser .btn.primary', { hasText: 'Open' }).click();
await page.waitForTimeout(600);
check('switching to the plugin viewer changes the active opener',
  (await topOpener()) === PLUGIN_OPENER, `${await topOpener()} vs ${PLUGIN_OPENER}`);
check('a one-off switch does not change the saved default', (await assoc())['.demo'] === 'core.text');

// 5. Settings lists the association and can forget it.
await page.evaluate(() => window.__trove.platform.workbench.setActivity('settings'));
await page.waitForSelector('.settings', { timeout: 3000 });
const hasRow = await page.locator('.settings .group', { hasText: 'Default Openers' }).locator('.setting', { hasText: '.demo' }).count();
check('settings shows the .demo default opener', hasRow >= 1);
await page.locator('.settings .group', { hasText: 'Default Openers' }).locator('.setting', { hasText: '.demo' }).locator('.iconbtn').first().click();
await page.waitForTimeout(300);
check('forgetting the default removes the association', !((await assoc())['.demo']), JSON.stringify(await assoc()));

done();
await close();
