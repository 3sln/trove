// Probe: server-side failure at startup. If the initial folder list 500s (server
// down / DB error), the app must still render its shell and tell the user the folder
// couldn't load — NOT white-screen or show a false "This folder is empty."

import { boot, checker } from './harness.mjs';

const { check, done } = checker();

const { page, errors, close, goto, setFault } = await boot({
  seed: async (vfs) => { await vfs.writeFile('root', 'hello.txt', 'hi', { contentType: 'text/plain' }); },
});

// Fail every folder-list call (server-side, deterministic) before the app loads.
setFault('/api/fs/list', true);

await goto();
check('workbench shell still renders despite a failing server', (await page.locator('.shell').count()) === 1);

// The launcher should surface the load failure, not a false "empty" or a stuck spinner.
// Wait long enough for the client's transient-retry backoff (~2s) to exhaust.
await page.waitForTimeout(4500);
const launcherText = await page.locator('.launcher').innerText().catch(() => '');
check('launcher shows the load error, not a false empty state',
  /couldn.t load this folder/i.test(launcherText) && !/this folder is empty/i.test(launcherText),
  launcherText.replace(/\s+/g, ' ').slice(0, 120));

// A toast should also have fired.
check('an error toast is shown', (await page.locator('.toasts .toast.error').count()) >= 1);

// Now recover: stop failing, refresh, and the folder should load.
setFault('/api/fs/list', false);
await page.evaluate(() => window.__trove.platform.commands?.execute?.('explorer.refresh')).catch(() => {});
await page.waitForTimeout(800);
const recovered = await page.evaluate(() => (window.__trove.app.explorer.state.items || []).map((i) => i.name));
check('folder loads after the server recovers', recovered.includes('hello.txt'), recovered.join(','));

check('app did not white-screen (activity bar present)', (await page.locator('.activitybar .item').count()) >= 1);

done();
await close();
