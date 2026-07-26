// Probe: the drive on a phone.
//
// The failure this is guarding against isn't "it looks cramped" — it's chrome that
// physically cannot be operated. A bottom bar that sits under the home indicator, a tab
// row wider than the screen, a status bar folded behind an icon that opens nothing, or a
// details panel that renders as a 340px sliver beside a 390px viewport. Each of those
// leaves the app looking fine in a screenshot and unusable in a hand.
//
// So this measures: where things actually are, whether they fit, and whether every
// destination the desktop rail offered is still reachable.

import { boot, checker } from './harness.mjs';

const { check, done } = checker();

// iPhone 14-ish: the narrow end of what people actually browse on.
const WIDTH = 390;
const HEIGHT = 844;

const { page, close, goto, errors, vfs } = await boot({
  page: { viewport: { width: WIDTH, height: HEIGHT }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 },
  seed: async (vfs) => {
    await vfs.writeFile('welcome.md', '# Welcome\n\nA document on the small screen.\n', { contentType: 'text/markdown' });
    await vfs.writeFile('notes.txt', 'some notes', { contentType: 'text/plain' });
  },
});
await goto();
await page.waitForSelector('.launch-item', { timeout: 5000 });

const box = (sel) => page.locator(sel).first().boundingBox();
const count = (sel) => page.locator(sel).count();
// The sheet slides up over ~180ms; measuring mid-animation would report it hanging off
// the bottom of the screen, which is the animation working, not a layout bug.
const openSheet = async (sel) => {
  await page.click(sel);
  await page.waitForSelector('.sheet', { timeout: 3000 });
  await page.waitForTimeout(260);
};

// --- 1. The phone shell is chosen, and the desktop chrome is gone -------------
check('a 390px viewport gets the phone shell', (await count('.shell.phone')) === 1);
check('the left rail is not rendered at all', (await count('.activitybar')) === 0,
  'hiding it in CSS would still cost a grid column');
check('the desktop status bar is not rendered', (await count('.statusbar')) === 0);
check('a top bar and a bottom tab bar are', (await count('.phonebar.top')) === 1 && (await count('.phonebar.bottom')) === 1);
check('<html> carries the layout for CSS to key off', await page.evaluate(() => document.documentElement.dataset.layout) === 'phone');

// --- 2. Nothing overflows the screen ------------------------------------------
const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
check('the page does not scroll sideways', docWidth <= WIDTH, `scrollWidth ${docWidth} vs ${WIDTH}`);

const tabs = await page.locator('.pb-tab').all();
const tabBoxes = await Promise.all(tabs.map((t) => t.boundingBox()));
check('every tab is inside the viewport', tabBoxes.every((b) => b.x >= 0 && b.x + b.width <= WIDTH + 0.5),
  tabBoxes.map((b) => `${Math.round(b.x)}..${Math.round(b.x + b.width)}`).join(' '));
// 44px is the smallest thing a finger reliably hits; anything less is a tap you miss.
check('every tab is at least 44px tall', tabBoxes.every((b) => b.height >= 44),
  tabBoxes.map((b) => Math.round(b.height)).join(','));
const bottom = await box('.phonebar.bottom');
check('the tab bar sits at the bottom of the screen', Math.abs(bottom.y + bottom.height - HEIGHT) < 1,
  `ends at ${Math.round(bottom.y + bottom.height)} of ${HEIGHT}`);

// The panel must not be hidden behind either bar.
const top = await box('.phonebar.top');
const launcher = await box('.launcher');
check('the panel starts below the top bar', launcher.y >= top.y + top.height - 1);
check('and ends above the tab bar', launcher.y + launcher.height <= bottom.y + 1,
  `panel ends ${Math.round(launcher.y + launcher.height)}, bar starts ${Math.round(bottom.y)}`);

// --- 3. The status bar folded into one icon that actually opens ---------------
check('the status icon is present', (await count('.pb-status')) === 1);
await openSheet('.pb-status');
const sheetText = await page.locator('.sheet').innerText();
check('the sheet reports the item count', /2\b/.test(sheetText) && /Items/i.test(sheetText), sheetText.replace(/\n/g, ' | '));
check('and the collection size', /Size/i.test(sheetText));
const sheetBox = await box('.sheet');
check('the sheet fits the screen', sheetBox.width <= WIDTH + 0.5 && sheetBox.y + sheetBox.height <= HEIGHT + 1);

// Tapping the scrim closes it — the gesture people try first.
await page.click('.sheet-wrap .scrim', { position: { x: 100, y: 60 } });
await page.waitForSelector('.sheet', { state: 'detached', timeout: 3000 });
check('tapping outside the sheet closes it', (await count('.sheet')) === 0);

// --- 4. Everything the rail offered is still reachable via More ---------------
await openSheet('.pb-tab:last-child');
const moreText = await page.locator('.sheet').innerText();
for (const label of ['Settings', 'Notifications', 'Activity', 'Trash', 'All commands']) {
  check(`"${label}" is reachable from the overflow`, moreText.includes(label), moreText.replace(/\n/g, ' | '));
}
// And it goes where it says.
await page.getByText('Settings', { exact: false }).first().click();
await page.waitForSelector('.settings', { timeout: 3000 }).catch(() => {});
check('picking Settings opens Settings', await page.evaluate(() => window.__trove.platform.workbench.state.activity) === 'settings');
check('and the sheet closed behind it', (await count('.sheet')) === 0);

// --- 5. A file opens full-width, and so do its details ------------------------
await page.click('.pb-tab');
await page.waitForSelector('.launch-item', { timeout: 4000 });
await page.click('.launch-item');
await page.waitForSelector('.editor-area, .viewer-nav', { timeout: 5000 });
const editor = await box('.editor-area, .viewer-nav');
check('the opened file uses the full width', editor.width >= WIDTH - 2, `${Math.round(editor.width)}px`);

await page.evaluate(() => window.__trove.platform.workbench.toggleInfoPanel(true));
await page.waitForSelector('.infopanel', { timeout: 3000 });
const info = await box('.infopanel');
// The desktop splits 1fr/340px. Doing that here would leave 50px for the file.
check('details take the whole panel instead of a sliver', info.width >= WIDTH - 2, `${Math.round(info.width)}px`);
check('and the editor is not squeezed in beside it', (await count('.editor-split')) === 0);
// Its own close button is the only way back to the file on a phone — there is no
// visible editor beside it to tap.
await page.click('.infopanel .ip-head .iconbtn');
await page.waitForSelector('.infopanel', { state: 'detached', timeout: 3000 }).catch(() => {});
check('details close again, returning to the file', (await count('.infopanel')) === 0
  && (await count('.editor-area, .viewer-nav')) > 0);

// --- 6. Rotating to landscape, and back ---------------------------------------
// Turned sideways there are 844 usable pixels, which is enough for the rail — so the
// desktop shell is the right answer, and the decision is by width rather than by device.
// What matters is that the chrome actually SWAPS: half a phone bar left over beside a
// rail would be worse than either shell alone.
await page.setViewportSize({ width: HEIGHT, height: WIDTH });
await page.waitForTimeout(150);
check('rotating to landscape re-decides on the new width',
  (await page.evaluate(() => window.__trove.platform.viewport.state.mode)) === 'desktop');
check('and the chrome swaps completely, leaving nothing of the old shell',
  (await count('.activitybar')) === 1 && (await count('.phonebar')) === 0);
await page.setViewportSize({ width: WIDTH, height: HEIGHT });
await page.waitForTimeout(150);
check('rotating back restores the phone shell', (await count('.shell.phone')) === 1);

const shot = (name) => page.screenshot({ path: new URL(`../screens/${name}`, import.meta.url).pathname });
await shot('20-phone-shell.png');
await openSheet('.pb-status');
await shot('21-phone-status-sheet.png');
await page.click('.sheet-wrap .scrim', { position: { x: 100, y: 60 } });

// --- 7. The override, which is how a TV or a mis-detected device is fixed ------
const bare = (await page.url()).split('?')[0];
await page.goto(bare + '?ui=desktop');
await page.waitForSelector('.shell', { timeout: 5000 });
check('?ui=desktop forces the desktop shell on a phone-sized screen',
  (await count('.activitybar')) === 1 && (await count('.phonebar')) === 0);
await page.goto(bare);
await page.waitForSelector('.launch-item', { timeout: 5000 });
check('and dropping the override goes back to the automatic choice', (await count('.shell.phone')) === 1);

// ERR_ABORTED is what navigating away mid-request looks like, and this probe reloads
// three times on purpose. Filtering it keeps the check about the app rather than about
// the probe's own navigation.
const real = errors.filter((e) => !e.includes('net::ERR_ABORTED'));
check('no uncaught errors along the way', real.length === 0, real.slice(0, 4).join(' | '));
done();
await close();
