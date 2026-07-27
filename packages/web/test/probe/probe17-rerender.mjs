// Probe: a forced re-render still redraws.
//
// Most of the shell renders from a store, so a change reaches the screen because the
// store's value changed. A few controls do not: recording a keyboard shortcut, ticking
// a capability before installing a plugin, and switching a driver in the new-collection
// dialog all keep their scratch state in a plain variable inside the render function.
// Those call `ui.rerender()`, which exists precisely because nothing observable moved.
//
// Under bones that always worked — its `watch` re-rendered on every emission, full
// stop. dodo's `watch` skips a render whose value is shallow-equal to the last one,
// which is a real improvement everywhere else and exactly wrong here: a bump that left
// no trace in the rendered value would be discarded as "nothing changed", and the
// button would simply never respond. There is no error, no warning, and no failing
// unit test — the UI just stops.
//
// So: press the thing, and look.

import { boot, checker } from './harness.mjs';

const { check, done } = checker();

const { page, close, goto, errors } = await boot({
  seed: async (vfs) => { await vfs.writeFile('note.txt', 'hello', { contentType: 'text/plain' }); },
});
await goto();
await page.waitForSelector('.launch-item', { timeout: 5000 });

await page.evaluate(() => window.__trove.platform.commands.execute('workbench.openSettings'));
await page.waitForSelector('.settings', { timeout: 4000 });

// --- recording a shortcut -----------------------------------------------------
const firstBinding = page.locator('.kbd-edit').first();
await firstBinding.waitFor({ timeout: 4000 });
const before = await firstBinding.innerText();
check('a shortcut row starts by showing its current chord', before.trim().length > 0, before);

await firstBinding.click();
// The ONLY thing that puts this row into its listening state is `ui.rerender()`:
// `capturing` is a module-level variable, and no store was touched.
await page.waitForSelector('.kbd-edit.listening', { timeout: 3000 }).catch(() => {});
const listening = await page.locator('.kbd-edit.listening').count();
check('clicking it starts listening — the forced re-render landed', listening === 1, String(listening));
check('and the row says so in words', /press keys/i.test(await page.locator('.kbd-edit.listening').innerText().catch(() => '')));

// Esc cancels, which is the same mechanism in reverse.
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.querySelectorAll('.kbd-edit.listening').length === 0, null, { timeout: 3000 })
  .catch(() => {});
check('Esc stops listening again', (await page.locator('.kbd-edit.listening').count()) === 0);

// --- the store path still works, for contrast ---------------------------------
// A setting change goes through SettingsService, so this one would survive even if
// `rerender` were broken. Checked so a failure above is unambiguous: it means the
// forced path, not rendering in general.
await page.evaluate(() => window.__trove.platform.settings.set('workbench.theme', 'light'));
await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', null, { timeout: 3000 });
check('a store-driven change still reaches the DOM', await page.evaluate(() => document.documentElement.dataset.theme) === 'light');

const real = errors.filter((e) => !e.includes('net::ERR_ABORTED'));
check('no uncaught errors along the way', real.length === 0, real.slice(0, 4).join(' | '));
done();
await close();
