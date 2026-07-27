// Probe: the view system — how the results are DRAWN.
//
// A view is a contribution, like an opener. The list is one; the grid is another; a
// hosted build ships a gallery and a plugin could ship a map. What has to hold, whatever
// is registered, is that the launcher stays the launcher: the same items, the same
// highlight, the same group actions, the same keyboard.
//
// So this drives the seams rather than the pixels — the switcher appears only when there
// is a choice, the choice survives, a picture-heavy drive picks the grid by itself, the
// group's Upload button is still there in tiles, and a view that throws leaves the drive
// readable instead of blank.

import { boot, checker } from './harness.mjs';

const { check, done } = checker();

const { page, close, goto, errors } = await boot({
  seed: async (vfs) => {
    // A one-pixel PNG, so the tiles have real bytes to fetch and decode.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    // Enough of them to fill more than one row of tiles — a single-row grid cannot show
    // that "down" means the row below, which is the whole point of the view answering
    // for its own arrow keys.
    for (const n of ['alps', 'boat', 'cliff', 'dune', 'esker', 'fjord', 'gorge', 'hill',
      'inlet', 'jetty', 'kelp', 'lagoon']) {
      await vfs.writeFile(`${n}.png`, png, { contentType: 'image/png' });
    }
    await vfs.writeFile('notes.txt', 'Where the photographs were taken.', { contentType: 'text/plain' });
  },
});
await goto();
await page.waitForSelector('.launch-item, .grid-tile', { timeout: 8000 });

const count = (sel) => page.locator(sel).count();
const viewIds = () => page.evaluate(() => window.__trove.platform.contributions
  .ofType('view').map((v) => v.id));

// --- 1. Two ways to look at it, and a switcher that says so --------------------
check('the list and the grid are both registered as views',
  JSON.stringify(await viewIds()) === JSON.stringify(['core.view.list', 'core.view.grid']),
  JSON.stringify(await viewIds()));
check('the switcher offers one button per view', (await count('.view-switch .vs-btn')) === 2);
check('exactly one of them reads as the current view', (await count('.vs-btn.on')) === 1);

// --- 2. A drive that is mostly photographs opens as a grid --------------------
// Nobody asked for this. Four pictures and one text file is a gallery, and the view's
// own `match` is what decides — the launcher knows nothing about images.
check('a picture-heavy collection draws as tiles without being asked', (await count('.grid-tile')) >= 12,
  `${await count('.grid-tile')} tiles`);
// `naturalWidth`, not a count of <img> elements. An image that 404s or fails to decode
// leaves the element in the DOM and the tile showing its icon, which is the graceful
// half — but it would also make a broken thumbnail pipeline look exactly like a working
// one from here.
const decoded = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll('.grid-tile .gt-img')];
  return { total: imgs.length, loaded: imgs.filter((i) => i.naturalWidth > 0).length };
});
check('and the pictures are really fetched and decoded, not just their icons drawn',
  decoded.total >= 12 && decoded.loaded === decoded.total, JSON.stringify(decoded));
// The thing a gallery must not cost you: the group header carries Upload, Empty trash
// and Retry. A view that dropped it would take those off the screen.
check('the group header — and its Upload button — survive the switch to tiles',
  (await count('.launch-group .launch-h')) >= 1 && (await count('.launch-h .launch-up')) >= 1);

// --- 3. Choosing wins over guessing, and is remembered ------------------------
await page.locator('.vs-btn[title="List view"]').click();
await page.waitForTimeout(300);
check('picking the list draws rows instead of tiles',
  (await count('.launch-item')) >= 13 && (await count('.grid-tile')) === 0);
check('the choice is what is saved, by id',
  (await page.evaluate(() => window.__trove.platform.settings.get('explorer.view'))) === 'core.view.list');

await page.reload();
await page.waitForSelector('.launch-item', { timeout: 8000 });
check('and it survives a reload, against what the contents would have suggested',
  (await count('.launch-item')) >= 13 && (await count('.grid-tile')) === 0);

// --- 4. The highlight is the launcher's, whichever view is drawing -------------
await page.locator('.vs-btn[title="Grid view"]').click();
await page.waitForTimeout(300);
await page.locator('.launch-input').focus();
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(200);
check('arrowing highlights a tile', (await count('.grid-tile.active')) === 1);
// The one thing the flat index gets wrong in two dimensions: down should mean the tile
// BELOW. The view measures its own column count and answers in the launcher's terms.
const rowStep = await page.evaluate(() => {
  const first = document.querySelector('.grid-tile.active');
  const before = { top: first.offsetTop, left: first.offsetLeft };
  return { before };
});
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(200);
const moved = await page.evaluate((before) => {
  const el = document.querySelector('.grid-tile.active');
  const cols = document.querySelectorAll('.grid-list .grid-tile').length;
  return { down: el.offsetTop > before.top, sameColumn: el.offsetLeft === before.left, cols };
}, rowStep.before);
check('down means the tile below it, not the tile beside it',
  moved.down && moved.sameColumn, JSON.stringify(moved));

// Selection follows the highlight, so the commands that act on "the selection" still
// work in a view that has no rows at all.
check('and the highlighted tile is genuinely selected',
  (await page.evaluate(() => window.__trove.app.explorer.selectedNodes?.().length
    ?? window.__trove.app.explorer.state.selected.length)) === 1);

// --- 5. Left and right belong to the caret while there is a caret --------------
await page.evaluate(() => {
  const el = document.querySelector('.launch-input');
  el.focus();
  el.value = 'boat';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(900);
const caret = await page.evaluate(async () => {
  const el = document.querySelector('.launch-input');
  el.setSelectionRange(4, 4);
  const active = () => [...document.querySelectorAll('.grid-tile, .launch-item')].findIndex((n) => n.classList.contains('active'));
  const before = active();
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 150));
  return { before, after: active() };
});
check('typing a query keeps left/right for fixing typos, not for moving the highlight',
  caret.before === caret.after, JSON.stringify(caret));

await page.evaluate(() => {
  const el = document.querySelector('.launch-input');
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(700);

// --- 6. A view belonging to a plugin that isn't there is not drawn -------------
// Availability is checked the same way an opener's is, so a view from a plugin that is
// uninstalled, offline or not answering never gets asked to draw. It also never leaves
// the drive blank: something else has to.
const absent = await page.evaluate(async () => {
  const t = window.__trove;
  t.platform.contributions.register('trove+contrib:acme.com/demo/gallery', {
    pluginId: 'acme.com/demo', type: 'view', title: 'Gallery', icon: 'grid', priority: 98,
    entry: 'src/views/gallery.js',
  });
  t.platform.settings.set('explorer.view', 'trove+contrib:acme.com/demo/gallery');
  t.platform.workbench.touch();
  await new Promise((r) => setTimeout(r, 400));
  return {
    offered: t.platform.contributions.ofType('view').some((v) => v.title === 'Gallery'),
    available: t.platform.plugins.isAvailable({ pluginId: 'acme.com/demo' }),
    switcher: document.querySelectorAll('.vs-btn').length,
    drawn: document.querySelectorAll('.grid-tile, .launch-item').length,
  };
});
check('a view whose plugin is not installed is registered but not offered',
  absent.offered && !absent.available && absent.switcher === 2, JSON.stringify(absent));
check('and choosing it does not leave the drive blank', absent.drawn >= 13, JSON.stringify(absent));

// --- 7. A view that throws degrades to the list, not to nothing ----------------
// A view is the WHOLE results area. One that throws takes the drive's contents off the
// screen with it, so the failure is caught where it can still be recovered from. This is
// registered as a build's own view (no plugin, so nothing filters it out) because that
// is exactly the case the guard is for: in-process code with no sandbox around it.
const degraded = await page.evaluate(async () => {
  const t = window.__trove;
  t.platform.contributions.register('core.view.broken', {
    type: 'view', title: 'Broken', icon: 'grid', priority: 99,
    render: () => { throw new Error('this view is broken'); },
  });
  t.platform.settings.set('explorer.view', 'core.view.broken');
  t.platform.workbench.touch();
  await new Promise((r) => setTimeout(r, 400));
  return {
    said: document.querySelector('.view-error')?.textContent || '',
    rows: document.querySelectorAll('.launch-item').length,
  };
});
check('a view that throws still leaves the files on screen', degraded.rows >= 13, JSON.stringify(degraded));
check('and says which view failed rather than failing silently',
  /Broken/.test(degraded.said), degraded.said);

// --- 8. One view left means no switcher at all ---------------------------------
const alone = await page.evaluate(async () => {
  const t = window.__trove;
  for (const id of ['core.view.broken', 'trove+contrib:acme.com/demo/gallery', 'core.view.grid']) {
    t.platform.contributions.unregister(id);
  }
  t.platform.settings.set('explorer.view', undefined);
  t.platform.workbench.touch();
  await new Promise((r) => setTimeout(r, 400));
  return {
    switcher: document.querySelectorAll('.view-switch').length,
    rows: document.querySelectorAll('.launch-item').length,
  };
});
check('with only one way to look at it, no switcher is offered', alone.switcher === 0, JSON.stringify(alone));
check('and the drive still draws', alone.rows >= 13, JSON.stringify(alone));

const real = errors.filter((e) => !e.includes('net::ERR_ABORTED') && !e.includes('this view is broken'));
check('no uncaught errors along the way', real.length === 0, real.slice(0, 4).join(' | '));
done();
await close();
