// Probe: opener conflict resolution. An .m4a matches both the Audiobook and the
// Audio player. Opening it should prompt; "Always use this" should remember the
// choice; a later open should skip the prompt; the viewer nav should offer a switch;
// and Settings should list + let you forget the association.

import { boot, checker } from './harness.mjs';

const { check, done } = checker();

const { page, close, goto } = await boot({
  seed: async (vfs) => {
    await vfs.writeFile('root', 'song.m4a', 'fake', { contentType: 'audio/mp4' });
    await vfs.writeFile('root', 'song2.m4a', 'fake', { contentType: 'audio/mp4' });
  },
});

await goto();
await page.waitForSelector('.launcher .launch-item', { timeout: 5000 });

const assoc = () => page.evaluate(() => window.__trove.platform.settings.get('openers.associations') || {});
const topOpener = () => page.evaluate(() => {
  const s = window.__trove.platform.workbench.state.stack;
  const t = s[s.length - 1];
  return t && t.kind === 'file' ? t.openerId : null;
});

// 1. Open the first .m4a → chooser appears with both openers.
await page.locator('.launch-item', { hasText: 'song.m4a' }).first().click();
await page.waitForSelector('.opener-chooser', { timeout: 3000 });
const optText = (await page.locator('.opener-opt .oo-title').allTextContents()).join(', ');
check('chooser lists both matching openers', /Audiobook/i.test(optText) && /Audio Player/i.test(optText), optText);

// 2. Pick "Audio Player", check "Always use", Open.
await page.locator('.opener-opt', { hasText: 'Audio Player' }).first().click();
await page.locator('.opener-remember input').check();
await page.locator('.opener-chooser .btn.primary', { hasText: 'Open' }).click();
await page.waitForSelector('.viewer', { timeout: 3000 });
check('opened with the chosen opener (core.audio)', (await topOpener()) === 'core.audio', String(await topOpener()));
check('choice remembered for .m4a', (await assoc())['.m4a'] === 'core.audio', JSON.stringify(await assoc()));

// 3. Back, open the SECOND .m4a → no prompt, opens directly with the remembered opener.
await page.locator('.viewer-nav .vn-back').first().click();
await page.waitForSelector('.launch-input', { timeout: 3000 });
await page.locator('.launch-item', { hasText: 'song2.m4a' }).first().click();
await page.waitForSelector('.viewer', { timeout: 3000 });
check('second open skips the prompt (remembered)', (await page.locator('.opener-chooser').count()) === 0 && (await topOpener()) === 'core.audio');

// 4. The viewer nav offers "Open with…"; clicking reopens the chooser.
const switchBtn = page.locator('.viewer-nav .vn-actions .iconbtn[title="Open with…"]');
check('viewer nav shows an "Open with…" switch', (await switchBtn.count()) >= 1);
await switchBtn.first().click();
await page.waitForSelector('.opener-chooser', { timeout: 3000 });
// Switch to the Audiobook player (one-off: leave "Always use" unchecked).
await page.locator('.opener-opt', { hasText: 'Audiobook' }).first().click();
await page.locator('.opener-chooser .btn.primary', { hasText: 'Open' }).click();
await page.waitForTimeout(400);
check('switching changes the active opener', (await topOpener()) === 'core.audiobook', String(await topOpener()));
check('a one-off switch does not change the saved default', (await assoc())['.m4a'] === 'core.audio');

// 5. Settings lists the association and can forget it.
await page.evaluate(() => window.__trove.platform.workbench.setActivity('settings'));
await page.waitForSelector('.settings', { timeout: 3000 });
const hasRow = await page.locator('.settings .group', { hasText: 'Default Openers' }).locator('.setting', { hasText: '.m4a' }).count();
check('settings shows the .m4a default opener', hasRow >= 1);
await page.locator('.settings .group', { hasText: 'Default Openers' }).locator('.setting', { hasText: '.m4a' }).locator('.iconbtn').first().click();
await page.waitForTimeout(300);
check('forgetting the default removes the association', !((await assoc())['.m4a']), JSON.stringify(await assoc()));

done();
await close();
