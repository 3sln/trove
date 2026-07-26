// Probe: the drive on a television, driven only by a remote.
//
// The rule this enforces is simple and unforgiving: FOUR ARROWS, OK, AND BACK. No mouse,
// no Tab key, no scroll wheel. So every check here is "can a remote get there", and the
// disqualifying failure is focus that goes nowhere — a screen where the arrows do
// nothing is a screen the user is stuck on with no way out but unplugging the TV.
//
// The other half is that the app must not become a TV everywhere else. The arrow keys
// are load-bearing on a desktop (scrolling, caret movement), so the same checks run
// against the desktop shell to confirm nothing was remapped there.

import { boot, checker } from './harness.mjs';

const { check, done } = checker();

const { page, close, goto, errors } = await boot({
  // 1080p, and the layout forced rather than sniffed — a headless Chromium has no
  // television in its user agent, which is exactly why the override exists.
  page: { viewport: { width: 1920, height: 1080 } },
  seed: async (vfs) => {
    for (const n of ['alpha.txt', 'bravo.txt', 'charlie.txt']) {
      await vfs.writeFile(n, `contents of ${n}`, { contentType: 'text/plain' });
    }
    await vfs.writeFile('readme.md', '# Readme\n\nOn the big screen.\n', { contentType: 'text/markdown' });
  },
});

await goto('/?ui=tv');
await page.waitForSelector('.launch-item', { timeout: 5000 });

const count = (sel) => page.locator(sel).count();
const focused = () => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  return { tag: el.tagName, cls: el.className || '', text: (el.innerText || el.value || '').trim().slice(0, 40) };
});
const press = async (key) => { await page.keyboard.press(key); await page.waitForTimeout(90); };
const settle_ = (p) => p.waitForTimeout(400);
// The app's clickable rows only become focusable once the service stamps a tabindex on
// them, which it does per frame. A probe that focused one before that would be testing
// its own timing, not the app.
const focusRow = async (sel, i = 0) => {
  await page.waitForFunction(
    ([s, n]) => document.querySelectorAll(s)[n]?.hasAttribute('tabindex'), [sel, i], { timeout: 4000 });
  await page.evaluate(([s, n]) => document.querySelectorAll(s)[n].focus(), [sel, i]);
};

check('the TV shell renders when asked for', (await count('.shell.tv')) === 1);

// --- 1. Something is focused to begin with -----------------------------------
// A remote cannot click on nothing. If the first frame has no focus, the first arrow
// press has no origin and the user is looking at a screen that does not respond.
const start = await focused();
check('something holds focus on arrival', start !== null, JSON.stringify(start));

// --- 2. The arrows move focus, and by geometry --------------------------------
// Out of the search box into the rail: left from the input must land on the rail, which
// is what is physically to the left of it.
await page.evaluate(() => document.querySelector('.launch-input').focus());
await press('ArrowLeft');
const rail = await focused();
check('left from the search box reaches the rail', /activitybar|item|brand-mark/.test(rail?.cls || ''),
  JSON.stringify(rail));

// Down walks the rail rather than leaping into the panel — the case naive
// nearest-distance scoring gets wrong.
const railBefore = await page.evaluate(() => {
  const el = document.activeElement;
  return el.getBoundingClientRect().top;
});
await press('ArrowDown');
const railNext = await focused();
const railAfter = await page.evaluate(() => document.activeElement.getBoundingClientRect().top);
check('down stays in the rail and moves down it',
  /activitybar|item|iconbtn|brand/.test(railNext?.cls || '') && railAfter > railBefore,
  `${Math.round(railBefore)} → ${Math.round(railAfter)} on ${railNext?.cls}`);

// And right comes back out of the rail into the panel.
await press('ArrowRight');
const backOut = await focused();
check('right leaves the rail for the panel', !/activitybar/.test(await page.evaluate(
  () => document.activeElement.closest('.activitybar') ? 'activitybar' : '')), JSON.stringify(backOut));

// --- 3. Every file in the list is reachable, and OK opens one -----------------
// Focus a file row, then confirm the arrows walk the list.
await focusRow('.launch-item');
const names = [];
for (let i = 0; i < 3; i++) {
  names.push((await focused())?.text?.split('\n')[0]);
  await press('ArrowDown');
}
check('down walks the file list one row at a time', new Set(names).size === 3, names.join(' → '));

await focusRow('.launch-item');
const target = (await focused())?.text?.split('\n')[0];
await press('Enter');
await page.waitForSelector('.viewer-nav', { timeout: 5000 }).catch(() => {});
check('OK opens the focused file', (await count('.viewer-nav')) === 1, `tried to open ${target}`);

// --- 4. Back gets you out, every time -----------------------------------------
// The one thing a remote must never fail at. If back doesn't work there is no escape.
await press('Backspace');
await page.waitForTimeout(200);
check('Back leaves the file and returns to the list', (await count('.launch-item')) > 0);

// Back closes an overlay before it navigates — closing the thing on top is what "back"
// means while something is on top.
await page.evaluate(() => window.__trove.platform.workbench.openPalette('commands'));
await page.waitForSelector('.palette', { timeout: 3000 });
await press('Backspace');
await page.waitForTimeout(200);
check('Back closes an open overlay first', (await count('.palette')) === 0);

// --- 5. Typing still works ----------------------------------------------------
// An on-screen keyboard sends Backspace as a backspace. Treating it as "go back" would
// throw away what the user typed and yank them off the screen mid-search.
await page.evaluate(() => document.querySelector('.launch-input').focus());
await page.keyboard.type('alpha');
await press('Backspace');
const typed = await page.evaluate(() => document.querySelector('.launch-input').value);
check('Backspace in the search box deletes a character, it does not navigate', typed === 'alph', `"${typed}"`);
check('and the search box still has focus', (await focused())?.cls?.includes('launch-input'));

// Left/right move the caret rather than jumping out of the field.
await press('ArrowLeft');
const caret = await page.evaluate(() => document.querySelector('.launch-input').selectionStart);
check('left moves the caret instead of leaving the field', caret === 3,
  `caret at ${caret}, focus ${(await focused())?.cls}`);

// --- 5b. Typing and picking in one motion -------------------------------------
// The most common thing anyone does on a TV: type a bit, then arrow down into the
// results. Focus stays in the search box (the launcher owns up/down there), so the
// browser's focus ring is on the FIELD while the row that will actually open is
// further down. That row has to carry a ring of its own, or the user is reading a
// screen where nothing visibly indicates what Enter will do.
await page.evaluate(() => { const i = document.querySelector('.launch-input'); i.focus(); i.select(); });
await page.keyboard.press('Backspace');
await settle_(page);
await press('ArrowDown');
await press('ArrowDown');
const activeRing = await page.evaluate(() => {
  const row = document.querySelector('.launch-item.active');
  if (!row) return null;
  const s = getComputedStyle(row);
  return { name: row.innerText.split('\n')[0], width: s.outlineWidth, style: s.outlineStyle };
});
check('the row the launcher has selected is ringed too, not just the search box',
  activeRing && parseFloat(activeRing.width) >= 3 && activeRing.style !== 'none', JSON.stringify(activeRing));

// --- 6. The focus ring is actually visible from a sofa ------------------------
await focusRow('.launch-item');
const ring = await page.evaluate(() => {
  const s = getComputedStyle(document.activeElement);
  return { width: s.outlineWidth, style: s.outlineStyle, color: s.outlineColor };
});
check('the focused item wears a thick outline', parseFloat(ring.width) >= 3 && ring.style !== 'none',
  JSON.stringify(ring));

// …and it is the ONLY thing wearing one. Two rows ringed identically — the remote's
// focus on one, the launcher's standing selection on another — reads as two equally
// chosen rows when only one of them will open.
const ringed = await page.evaluate(() => [...document.querySelectorAll('.launch-item')]
  .filter((el) => {
    const s = getComputedStyle(el);
    return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 3;
  })
  .map((el) => el.innerText.split('\n')[0]));
check('and it is the only row wearing one', ringed.length === 1, ringed.join(', ') || 'nothing ringed');

// Overscan: the outer few percent of a TV picture is cropped on plenty of sets, so the
// rail must not begin at x=0.
const railBox = await page.locator('.activitybar').boundingBox();
check('the rail is inset for overscan', railBox.x >= 20, `starts at x=${Math.round(railBox.x)}`);

await page.screenshot({ path: new URL('../screens/22-tv-shell.png', import.meta.url).pathname });

// --- 7. None of this leaks onto a desktop -------------------------------------
// Arrow keys are load-bearing in a normal browser. Remapping them there would break
// scrolling and text editing for every user who is not on a television.
await page.goto((await page.url()).split('?')[0]);
await page.waitForSelector('.launch-item', { timeout: 5000 });
check('a desktop gets the desktop shell', (await count('.shell.tv')) === 0);
check('and spatial navigation switched itself off',
  (await page.evaluate(() => window.__trove.platform.spatialNav.active)) === false);

await page.evaluate(() => document.querySelector('.launch-input').focus());
await page.keyboard.type('br');
await press('ArrowLeft');
const deskCaret = await page.evaluate(() => document.querySelector('.launch-input').selectionStart);
check('arrow keys behave normally on a desktop', deskCaret === 1, `caret at ${deskCaret}`);

const real = errors.filter((e) => !e.includes('net::ERR_ABORTED'));
check('no uncaught errors along the way', real.length === 0, real.slice(0, 4).join(' | '));
done();
await close();
