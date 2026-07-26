// Probe: the round-1 selection fix, finished.
//
// Round 1 made the launcher's highlighted row the selection, which made delete/rename/
// copy-link reachable. It was only half a fix: `selectedNodes()` resolved ids against
// the loaded page of the CURRENT collection, and the launcher's rows come from search
// (which the server scopes to every readable collection) and from recents (which
// survive a collection switch). So every row you reached by searching selected an id
// the explorer could not resolve, and the three commands that act on "the selection"
// returned silently while `explorer.hasSelection` said there was one.
//
// Also here: the phone details panel, which a long filename pushed off the screen —
// taking its own Close button and the Comment button with it.

import { boot, checker } from './harness.mjs';

const { check, done } = checker();

const LONG = 'quarterly-revenue-and-headcount-review-2024-final.txt';

const { page, close, goto, errors } = await boot({
  seed: async (vfs) => {
    for (let i = 0; i < 40; i++) {
      await vfs.writeFile(`filler-${String(i).padStart(2, '0')}.txt`, 'x', { contentType: 'text/plain' });
    }
    await vfs.writeFile('needle.txt', 'a distinctive haystack sentence', { contentType: 'text/plain' });
    await vfs.writeFile(LONG, 'revenue', { contentType: 'text/plain' });
  },
});
await goto();
await page.waitForSelector('.launch-item', { timeout: 8000 });

// --- a searched-for row is a real selection ------------------------------------

// Shrink the loaded page so `needle.txt` cannot be on it, which is what makes the id
// unresolvable against `state.items` — the same situation a search hit from another
// collection is in.
await page.evaluate(() => {
  const ex = window.__trove.app.explorer;
  ex.set({ items: ex.state.items.slice(0, 3) });
});

await page.fill('.launch-input', 'haystack');
await page.waitForTimeout(900);
const results = await page.$$eval('.launch-item .name', (els) => els.map((e) => e.textContent));
check('the search finds it', results.includes('needle.txt'), results.join(', '));

// Walk down to `needle.txt` wherever the ranking put it. What matters is that the
// highlighted row and the selection agree — not which row that happens to be.
let highlighted = null;
for (let i = 0; i < 45 && highlighted !== 'needle.txt'; i++) {
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(40);
  highlighted = await page.$eval('.launch-item.active .name', (e) => e.textContent).catch(() => null);
}
const sel = await page.evaluate(() => {
  const ex = window.__trove.app.explorer;
  return {
    ids: ex.state.selection,
    nodes: ex.selectedNodes().map((n) => n.name),
    onPage: ex.state.items.map((i) => i.name),
    ctx: window.__trove.platform.context.get('explorer.hasSelection'),
  };
});
check('the highlight reached the searched file', highlighted === 'needle.txt', String(highlighted));
check('which is NOT on the loaded page', !sel.onPage.includes('needle.txt'), sel.onPage.join(', '));
check('selecting a searched row resolves to a real node', sel.nodes.length === 1,
  `selection=${sel.ids.length} nodes=[${sel.nodes}] page=[${sel.onPage.slice(0, 3)}…]`);
check('and it is the row that was highlighted', sel.nodes[0] === highlighted, `${sel.nodes[0]} vs ${highlighted}`);
check('the context key and the selection agree', sel.ctx === (sel.nodes.length > 0), String(sel.ctx));

// Rename is one of the three that took the silent path.
await page.evaluate(() => window.__trove.platform.commands.execute('explorer.rename'));
await page.waitForTimeout(400);
const dialog = await page.$eval('.dialog', (e) => e.textContent).catch(() => '');
check('Rename opens on a searched row', /rename/i.test(dialog), dialog.slice(0, 60) || '(no dialog)');
const value = await page.$eval('.dialog .input', (e) => e.value).catch(() => '');
check('and it is renaming the right file', value === 'needle.txt', value);
await page.evaluate(() => window.__trove.platform.commands.execute('workbench.closeOverlays'));

// --- and with nothing selected, the command says so ----------------------------

await page.evaluate(() => {
  window.__trove.app.explorer.select([]);
  window.__trove.platform.workbench.showHome();
});
await page.waitForTimeout(300);
await page.evaluate(() => window.__trove.platform.commands.execute('explorer.copyLink'));
await page.waitForTimeout(300);
const toast = await page.$$eval('.toast', (els) => els.map((e) => e.textContent).join(' | '));
check('with nothing picked, the command explains itself', /pick a file/i.test(toast), toast || '(silence)');

// --- the phone details panel stays on the phone --------------------------------

await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => window.__trove.platform.commands.execute('workbench.closeOverlays'));
await page.evaluate((name) => {
  const app = window.__trove.app;
  const node = app.explorer.state.items.find((i) => i.name === name);
  window.__trove.platform.workbench.openFile(node);
}, LONG).catch(() => {});
await page.waitForTimeout(400);
// Fall back to opening it through the list if the direct call didn't take.
if (!(await page.$('.viewer-nav'))) {
  await page.fill('.launch-input', 'quarterly');
  await page.waitForTimeout(800);
  await page.click('.launch-item');
  await page.waitForTimeout(600);
}
await page.evaluate(() => window.__trove.platform.workbench.toggleInfoPanel(true));
await page.waitForSelector('.infopanel', { timeout: 4000 });
await page.waitForTimeout(400);

const panel = await page.evaluate(() => {
  const el = document.querySelector('.infopanel');
  const r = el.getBoundingClientRect();
  const btn = el.querySelector('.ip-head .iconbtn');
  const b = btn?.getBoundingClientRect();
  const hit = b ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null;
  return {
    width: Math.round(r.width),
    viewport: window.innerWidth,
    closeOnScreen: b ? b.right <= window.innerWidth : false,
    closeTappable: !!(btn && hit && (hit === btn || btn.contains(hit))),
  };
});
// A flex container ignores `text-overflow`, and its child defaults to `min-width: auto`
// — "never shrink below your content" — so the URI pushed the panel wider than the
// screen. `body { overflow: hidden }` then hid the evidence: the panel just looked
// cropped, with its own close button past the right edge.
check('the details panel fits the phone', panel.width <= panel.viewport,
  `${panel.width}px in ${panel.viewport}px`);
check('its close button is on screen', panel.closeOnScreen);
check('and can actually be tapped', panel.closeTappable);

const uri = await page.evaluate(() => {
  const el = document.querySelector('.ip-uri > span');
  if (!el) return null;
  const s = getComputedStyle(el);
  return { ellipsis: s.textOverflow, overflow: s.overflow, fits: el.scrollWidth <= el.clientWidth + 1 };
});
check('the trove: link is ellipsised rather than hard-clipped',
  !uri || uri.ellipsis === 'ellipsis', JSON.stringify(uri));

// --- a long menu can be scrolled to its end ------------------------------------

await page.setViewportSize({ width: 1280, height: 700 });
await page.evaluate(() => window.__trove.platform.commands.execute('workbench.view.home'));
await page.waitForTimeout(300);
await page.evaluate(() => {
  const items = [];
  for (let i = 0; i < 24; i++) items.push({ label: `Entry number ${i}`, run: () => {} });
  window.__trove.platform.workbench.showContextMenu(40, 40, items);
});
await page.waitForSelector('.menu', { timeout: 3000 });
const menu = await page.evaluate(() => {
  const el = document.querySelector('.menu');
  const r = el.getBoundingClientRect();
  return { bottom: Math.round(r.bottom), h: window.innerHeight, scrollable: el.scrollHeight > el.clientHeight + 1 };
});
check('a long menu stays inside the window', menu.bottom <= menu.h, `${menu.bottom} vs ${menu.h}`);
check('and scrolls to reach its last entry', menu.scrollable || menu.bottom <= menu.h, JSON.stringify(menu));

check('no uncaught errors', errors.filter((e) => !e.includes('net::ERR_ABORTED')).length === 0,
  errors.slice(0, 3).join(' | ') || 'none');
done();
await close();
