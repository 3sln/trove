// Probe: a failed search is not a dead end — it shows an error AND a Retry that
// re-runs once the server recovers.

import { boot, checker } from './harness.mjs';

const { check, done } = checker();

const { page, close, goto, setFault } = await boot({
  seed: async (vfs) => { await vfs.writeFile('root', 'sailing.txt', 'tacking upwind across the bay', { contentType: 'text/plain' }); },
});

await goto();
await page.waitForSelector('.launch-input', { timeout: 5000 });

// Break search, then run one.
setFault('/api/query', true);
await page.locator('.launch-input').fill('bay');
await page.waitForTimeout(2600); // let the debounce + retry backoff exhaust

const bodyText = await page.locator('.launcher').innerText();
check('failed search shows an error (not a false "no results")', /search failed|couldn.t search/i.test(bodyText), bodyText.replace(/\s+/g, ' ').slice(0, 100));
check('a Retry affordance is offered', (await page.locator('.launch-group .launch-up', { hasText: 'Retry' }).count()) >= 1);

// Recover + retry → results appear.
setFault('/api/query', false);
await page.locator('.launch-group .launch-up', { hasText: 'Retry' }).first().click();
await page.waitForTimeout(1200);
const names = await page.locator('.launch-item .name').allTextContents();
check('Retry re-runs the search and finds results', names.includes('sailing.txt'), names.join(','));

done();
await close();
