// Probe: you can always see where you are.
//
// A keyboard user's cursor is the focus indicator. If an element can take focus and
// looks identical focused and unfocused, that user is typing blind — and it is invisible
// to every other kind of test, because the DOM is correct and the behaviour is correct.
// Only the pixels are wrong.
//
// So this measures the actual difference: for every focusable element, computed style
// with focus versus without. Something must change, and it must be something you can
// see — an outline, a ring, a background, a colour.
//
// It also guards the rule that made the old ring ugly: a focus style may not change an
// element's SHAPE. The base rule used to set `border-radius: 3px`, which snapped every
// pill button to near-square on focus.

import { boot, checker } from './harness.mjs';

const { check, done } = checker();

const { page, close, goto, errors } = await boot({
  seed: async (vfs) => {
    await vfs.writeFile('Reading list.md',
      '# Reading list\n\n- [Sailing](trove:default?name=sailing.txt)\n\nProse with a [link](trove:default?name=sailing.txt).\n',
      { contentType: 'text/markdown' });
    await vfs.writeFile('sailing.txt', 'Trimming the mainsail.', { contentType: 'text/plain' });
    await vfs.writeFile('cooking.txt', 'Braising short ribs.', { contentType: 'text/plain' });
  },
});
await goto();
await page.waitForSelector('.launch-item', { timeout: 8000 });

/**
 * Does focusing this element change anything visible?
 *
 * Compares the computed style of the element AND its children (a hidden checkbox shows
 * its focus on the track beside it, which is the correct pattern, not a cheat).
 */
const focusEffect = (selector, index = 0) => page.evaluate(([sel, i]) => {
  const el = document.querySelectorAll(sel)[i];
  if (!el) return { missing: true };
  const targets = [el, ...el.parentElement ? [el.parentElement] : [], ...el.querySelectorAll('*')].slice(0, 8);
  const snap = () => targets.map((t) => {
    const s = getComputedStyle(t);
    return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.backgroundColor, s.color, s.borderColor].join('|');
  }).join('~');

  el.blur();
  document.body.focus();
  const before = snap();
  const radiusBefore = getComputedStyle(el).borderRadius;

  // Force the :focus-visible heuristic the way a keyboard actually does.
  el.focus({ focusVisible: true });
  const after = snap();
  const radiusAfter = getComputedStyle(el).borderRadius;
  const s = getComputedStyle(el);
  return {
    changed: before !== after,
    radiusChanged: radiusBefore !== radiusAfter,
    radiusBefore,
    radiusAfter,
    outline: `${s.outlineStyle} ${s.outlineWidth}`,
    shadow: s.boxShadow === 'none' ? '' : 'shadow',
  };
}, [selector, index]);

// Every kind of interactive surface in the app, one representative of each.
const SURFACES = [
  ['the search box', '.launch-input'],
  // File rows are deliberately NOT in the tab order — the launcher is a Spotlight-style
  // list driven by arrow keys from the search field, and tabbing through a thousand
  // files would be worse than useless. Its `.active` row is checked separately below.
  ['a rail destination', '.activitybar .item'],
  ['the brand mark', '.activitybar .brand-mark'],
  ['the notification bell', '.activitybar .iconbtn'],
  ['a status bar segment', '.statusbar .seg'],
];

for (const [name, sel] of SURFACES) {
  const r = await focusEffect(sel);
  check(`${name} shows focus`, !r.missing && r.changed,
    r.missing ? 'element not found' : `outline=${r.outline} ${r.shadow}`);
  check(`${name} keeps its shape`, !r.missing && !r.radiusChanged,
    r.radiusChanged ? `${r.radiusBefore} → ${r.radiusAfter}` : r.radiusBefore);
}

// The launcher's own selection is the affordance that replaces focus for file rows, so
// it has to be unmistakable — and in particular must not look like a mouse hover, or
// arrowing down produces a highlight the user cannot tell from where the pointer rests.
const rowStates = await page.evaluate(() => {
  const row = document.querySelector('.launch-item');
  const read = () => { const s = getComputedStyle(row); return `${s.backgroundColor}|${s.boxShadow}`; };
  row.classList.remove('active');
  const plain = read();
  row.classList.add('active');
  const active = read();
  row.classList.remove('active');
  return { plain, active, differs: plain !== active, hasBar: active.includes('inset') };
});
check('the selected row is clearly marked', rowStates.differs, rowStates.active.slice(0, 60));
check('and marked with more than a background tint', rowStates.hasBar, rowStates.active.slice(0, 60));

// --- Settings: the toggle is the one whose real control is invisible ----------
await page.evaluate(() => window.__trove.platform.commands.execute('workbench.openSettings'));
await page.waitForSelector('.settings', { timeout: 4000 });
await page.waitForTimeout(400);

for (const [name, sel] of [
  ['a settings dropdown', '.settings select.input'],
  // The checkbox is `opacity: 0; width: 0` — focusing it changed nothing at all, so a
  // keyboard user could not tell which toggle they were on.
  ['a settings toggle', '.switch input'],
  ['a number field', '.settings input.input'],
]) {
  const r = await focusEffect(sel);
  check(`${name} shows focus`, !r.missing && r.changed, r.missing ? 'not found' : `outline=${r.outline} ${r.shadow}`);
}

// --- A file open: viewer chrome, prose links, panel buttons -------------------
await page.evaluate(() => window.__trove.platform.commands.execute('workbench.view.home'));
await page.waitForSelector('.launch-item', { timeout: 5000 });
// By name, not by position. The list is sorted case-INSENSITIVELY (which is what the
// sqlite store always did and the memory store now matches), so "Reading list.md" is
// not the first row and clicking blind opened a plain text file with no links in it.
await page.locator('.launch-item', { hasText: 'Reading list.md' }).first().click();
await page.waitForSelector('.viewer-nav', { timeout: 5000 });
await page.waitForTimeout(500);

for (const [name, sel] of [
  ['the back button', '.vn-back'],
  ['a link in rendered markdown', '.md a'],
]) {
  const r = await focusEffect(sel);
  check(`${name} shows focus`, !r.missing && r.changed, r.missing ? 'not found' : `outline=${r.outline} ${r.shadow}`);
}

await page.evaluate(() => window.__trove.platform.commands.execute('workbench.toggleInfoPanel'));
await page.waitForSelector('.infopanel', { timeout: 4000 });
await page.waitForTimeout(300);
const btn = await focusEffect('.infopanel .btn');
check('a button shows focus', btn.changed, `outline=${btn.outline} ${btn.shadow}`);
check('and a rounded button stays rounded', !btn.radiusChanged, `${btn.radiusBefore} → ${btn.radiusAfter}`);

// --- Phone chrome -------------------------------------------------------------
await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => window.__trove.platform.commands.execute('workbench.view.home'));
await page.waitForSelector('.pb-tab', { timeout: 5000 });
await page.waitForTimeout(400);
for (const [name, sel] of [['a phone tab', '.pb-tab'], ['the phone status icon', '.pb-status']]) {
  const r = await focusEffect(sel);
  check(`${name} shows focus`, !r.missing && r.changed, r.missing ? 'not found' : `outline=${r.outline} ${r.shadow}`);
}

// --- Tabbing actually reaches things, in a sane order -------------------------
await page.setViewportSize({ width: 1280, height: 800 });
await page.evaluate(() => window.__trove.platform.commands.execute('workbench.view.home'));
await page.waitForSelector('.launch-item', { timeout: 5000 });
await page.evaluate(() => document.body.focus());
const visited = [];
for (let i = 0; i < 8; i++) {
  await page.keyboard.press('Tab');
  await page.waitForTimeout(60);
  visited.push(await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    // The indicator may sit on an ANCESTOR — a borderless input lights up the box that
    // draws it, which is the right pattern rather than a dodge. Walk up a couple of
    // levels before calling it invisible.
    let node = el;
    for (let d = 0; d < 3 && node; d++, node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.outlineStyle !== 'none' || s.boxShadow !== 'none') {
        return { cls: (el.className || el.tagName).toString().slice(0, 30), visible: true };
      }
    }
    return { cls: (el.className || el.tagName).toString().slice(0, 30), visible: false };
  }));
}
const real = visited.filter(Boolean);
check('tabbing moves through real controls', real.length >= 4, real.map((v) => v.cls).join(' → '));
check('and every one of them is visibly focused', real.every((v) => v.visible),
  real.filter((v) => !v.visible).map((v) => v.cls).join(', ') || 'all visible');

check('no uncaught errors', errors.filter((e) => !e.includes('net::ERR_ABORTED')).length === 0);
done();
await close();
