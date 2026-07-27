// Probe: can you actually DO the thing?
//
// A command can be registered, tested, documented and completely unreachable. Three of
// them were: `explorer.delete` acted on a selection that nothing ever set, so there was
// no way to delete a file in any shell; `collections.switch` had no caller and passed
// two arguments to a one-argument constructor; `explorer.purgeOne` existed only behind
// an all-or-nothing Empty Trash.
//
// So this probe doesn't check that the handlers work — the unit tests do that. It checks
// that a person sitting in front of the app can reach them, by clicking what is on the
// screen.

import { boot, checker } from './harness.mjs';

const { check, done } = checker();

const { page, close, goto, errors } = await boot({
  seed: async (vfs) => {
    await vfs.writeFile('keep.txt', 'kept', { contentType: 'text/plain' });
    await vfs.writeFile('doomed.txt', 'about to go', { contentType: 'text/plain' });
  },
});
await goto();
await page.waitForSelector('.launch-item', { timeout: 8000 });

const rowNames = () => page.$$eval('.launch-item .name', (els) => els.map((e) => e.textContent));
const rowFor = async (name) => {
  const rows = await page.$$('.launch-item');
  for (const r of rows) {
    if ((await r.$eval('.name', (e) => e.textContent)) === name) return r;
  }
  return null;
};

// --- the highlight is the selection -------------------------------------------

await page.click('.launch-input');
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(150);
const selected = await page.evaluate(() => window.__trove.app.explorer.selectedNodes().map((n) => n.name));
check('arrowing to a row selects it', selected.length === 1, selected.join(', ') || 'nothing selected');

const ctx = await page.evaluate(() => window.__trove.platform.context.get('explorer.hasSelection'));
check('and the context key the Delete shortcut is gated on goes true', ctx === true, String(ctx));

// --- every row carries its actions --------------------------------------------

const doomed = await rowFor('doomed.txt');
check('a file row has an actions button', !!(await doomed.$('.launch-more')));

await doomed.hover();
await doomed.$eval('.launch-more', (b) => b.click());
await page.waitForSelector('.menu .mi', { timeout: 4000 });
const labels = await page.$$eval('.menu .mi span:first-of-type', (els) => els.map((e) => e.textContent));
for (const want of ['Open', 'Download', 'Copy link', 'Rename…', 'Move to trash']) {
  check(`the row menu offers "${want}"`, labels.includes(want), labels.join(' · '));
}
check('menu entries are focusable buttons', await page.$eval('.menu .mi', (e) => e.tagName) === 'BUTTON');

// --- delete, for real ----------------------------------------------------------

const menuItem = async (label) => {
  const items = await page.$$('.menu .mi');
  for (const it of items) if ((await it.textContent()).includes(label)) return it;
  return null;
};
await (await menuItem('Move to trash')).click();
await page.waitForSelector('.dialog', { timeout: 4000 });
const body = await page.$eval('.dialog', (e) => e.textContent);
check('deleting asks first, and says what actually happens', /trash/i.test(body), body.slice(0, 90));
check('and names the file', body.includes('doomed.txt'), body.slice(0, 90));

// The two checks above passed for months while this dialog rendered ONE WORD PER
// LINE. `.body` is also the shell's rail+main grid class, so the prose was landing
// in a 52px column — the text was correct, and every assertion that reads innerText
// is blind to that. A layout defect needs a geometric assertion, so: measure it.
const prose = await page.$eval('.dialog .body', (e) => {
  const cs = getComputedStyle(e);
  const r = e.getBoundingClientRect();
  return { display: cs.display, height: r.height, width: r.width, lineHeight: parseFloat(cs.lineHeight) || 20 };
});
check('the dialog\'s prose lays out as prose, not one word per line',
  prose.height <= prose.lineHeight * 4, JSON.stringify(prose));
check('and it uses the width the dialog gives it', prose.width > 200, String(Math.round(prose.width)));

await page.click('.dialog .btn.primary');
await page.waitForTimeout(700);
const after = await rowNames();
check('the file is gone from the list', !after.includes('doomed.txt'), after.join(', '));
check('and the other one is not', after.includes('keep.txt'), after.join(', '));

// --- the trash can be opened, and one item purged from it ----------------------

await page.evaluate(() => window.__trove.platform.commands.execute('explorer.showTrash'));
await page.waitForTimeout(600);
const trashed = await rowNames();
check('the trash shows what was deleted', trashed.includes('doomed.txt'), trashed.join(', '));

const trashRow = await rowFor('doomed.txt');
await trashRow.hover();
await trashRow.$eval('.launch-more', (b) => b.click());
await page.waitForSelector('.menu .mi', { timeout: 4000 });
const trashLabels = await page.$$eval('.menu .mi span:first-of-type', (els) => els.map((e) => e.textContent));
check('a trashed row offers Restore', trashLabels.includes('Restore'), trashLabels.join(' · '));
// The one that was unreachable: purging a SINGLE item, rather than destroying everything.
check('and Delete forever', trashLabels.includes('Delete forever'), trashLabels.join(' · '));

await (await menuItem('Restore')).click();
await page.waitForTimeout(700);
check('restoring puts the file back', (await rowNames()).includes('doomed.txt'), (await rowNames()).join(', '));

// --- upload is reachable on the desktop ----------------------------------------

await page.evaluate(() => window.__trove.platform.commands.execute('workbench.view.home'));
await page.waitForSelector('.launch-item', { timeout: 5000 });
const uploadBtn = await page.$$eval('.launch-h .launch-up', (els) => els.map((e) => e.textContent));
check('there is an Upload control on the desktop', uploadBtn.some((t) => /upload/i.test(t)), uploadBtn.join(' · '));

// --- switching collections -----------------------------------------------------

// `collections.switch` used to dispatch NavigateAction('/', cid) against a
// single-argument constructor: it navigated to a collection literally named "/".
const before = await page.evaluate(() => window.__trove.app.explorer.state.collectionId);
await page.evaluate(() => window.__trove.platform.commands.execute('collections.switch', 'default'));
await page.waitForTimeout(600);
const nowAt = await page.evaluate(() => window.__trove.app.explorer.state.collectionId);
check('switching lands on the collection asked for', nowAt === 'default', `${before} → ${nowAt}`);
const err = await page.evaluate(() => window.__trove.app.explorer.state.error);
check('and does not fail to load it', !err, err || 'no error');

check('the status bar collection segment is a switcher', await page.$eval('.statusbar .seg[title]', (e) => e.title) !== null);

// --- the details panel says why nothing happened -------------------------------

await page.evaluate(() => window.__trove.platform.commands.execute('workbench.closeOverlays'));
await page.evaluate(() => window.__trove.platform.commands.execute('workbench.toggleInfoPanel'));
await page.waitForTimeout(400);
const toast = await page.$$eval('.toast', (els) => els.map((e) => e.textContent).join(' | '));
check('toggling details with nothing open explains itself', /open a file/i.test(toast), toast || '(silence)');

check('no uncaught errors', errors.filter((e) => !e.includes('net::ERR_ABORTED')).length === 0,
  errors.join(' | ') || 'none');
done();
await close();
