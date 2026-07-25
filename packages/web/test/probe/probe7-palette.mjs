// Probe: the command palette's input handler must act on the palette's CURRENT mode,
// not the mode that was on screen when its listener was created.
//
// Rendering is async, so a keystroke can land between `openPalette('files')` and the
// re-render that switches the field to files mode. A listener that captured `pal.mode`
// then treats that keystroke as a COMMAND-mode one: no search is dispatched, and
// because the vdom only patches `value` when the prop changed, the typed text sits in
// the DOM with nothing behind it. The user sees their query and "No files found".
//
// Also covers: a failed quick-open must not be reported as "no files found", and a
// reopened palette must not show the previous query's hits.

import { boot, checker } from './harness.mjs';

const { check, done } = checker();

const { page, close, goto, setFault } = await boot({
  seed: async (vfs) => {
    const docs = await vfs.mkdir('root', 'documents');
    await vfs.writeFile(docs.id, 'cooking.txt', 'braising short ribs low and slow', { contentType: 'text/plain' });
    await vfs.writeFile('root', 'notes.txt', 'unrelated notes', { contentType: 'text/plain' });
  },
});
await goto();

const palette = () => page.evaluate(() => {
  const se = window.__trove.app.search.state;
  return {
    names: (se.paletteFiles || []).map((r) => r.node.name),
    q: se.paletteQuery, error: se.paletteError,
    dom: document.querySelector('.palette input')?.value ?? null,
    shown: [...document.querySelectorAll('.palette .opt .title')].map((e) => e.textContent),
    none: document.querySelector('.palette .none')?.textContent?.trim() ?? null,
  };
});

// --- 1. Type immediately after switching modes, with no render in between ------
// The switch and the keystroke happen back to back, which is the racy ordering the
// walkthrough hit intermittently. Doing both without an await makes it deterministic.
await page.evaluate(() => window.__trove.platform.workbench.openPalette('commands'));
await page.waitForSelector('.palette input', { timeout: 3000 });
await page.locator('.palette input').fill('settings');
await page.waitForTimeout(250);

// Switch to files mode and type in the SAME task: the listener on the live input is
// still the one the commands-mode render created.
await page.evaluate(() => {
  const el = document.querySelector('.palette input');
  window.__trove.platform.workbench.openPalette('files');
  el.value = 'cooking';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForFunction(() => (window.__trove.app.search.state.paletteFiles || []).length > 0, { timeout: 6000 }).catch(() => {});
const raced = await palette();
check('a keystroke racing the mode switch still runs a file search',
  raced.names.includes('cooking.txt'), JSON.stringify(raced));
check('what the field shows and what was searched agree',
  raced.dom === raced.q, `dom=${raced.dom} searched=${raced.q}`);

// --- 2. Reopening must not show the previous query's results -------------------
await page.keyboard.press('Escape');
await page.evaluate(() => window.__trove.platform.workbench.openPalette('files'));
await page.waitForTimeout(200);
const reopened = await palette();
check('a reopened palette shows no stale hits from the last query',
  reopened.shown.length === 0, JSON.stringify(reopened.shown));
check('an empty query prompts rather than claiming nothing matched',
  /type to search/i.test(reopened.none || ''), String(reopened.none));

// --- 3. A failed search says so, instead of "No files found" -------------------
setFault('/api/search', true);
await page.locator('.palette input').fill('cooking');
await page.waitForFunction(() => window.__trove.app.search.state.paletteError, { timeout: 6000 }).catch(() => {});
const failed = await palette();
check('a failed quick-open surfaces the error', !!failed.error, JSON.stringify(failed.error));
check('a failed quick-open does NOT claim the drive has no match',
  !/no files found/i.test(failed.none || ''), String(failed.none));

// --- 4. …and recovers on the next keystroke -----------------------------------
setFault('/api/search', false);
await page.locator('.palette input').fill('cooking ');
await page.waitForFunction(() => (window.__trove.app.search.state.paletteFiles || []).length > 0, { timeout: 6000 }).catch(() => {});
const recovered = await palette();
check('the next search clears the error and returns results',
  recovered.error === null && recovered.names.includes('cooking.txt'), JSON.stringify(recovered));

done();
await close();
