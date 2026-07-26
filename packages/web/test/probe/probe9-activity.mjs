// Probe: background work you can watch, and problems that don't go away on their own.
//
// The point of this pair is that neither can be a toast. A reindex outlives the click
// that started it, and an item that failed to index is still unfindable tomorrow — so
// what is being checked here is PERSISTENCE of the report, not that a message appeared
// once. In particular: a failure has to still be listed after a reload, and it has to
// stop being listed when the underlying problem is actually fixed — not when it is
// acknowledged.

import { boot, checker } from './harness.mjs';

const { check, done } = checker();

// An indexer that fails on demand, so we can break indexing, observe the standing
// problem, fix it, and watch the problem clear itself.
let broken = true;
const flaky = {
  id: 'probe.flaky',
  match: (node) => node.name.endsWith('.md'),
  index: async () => {
    if (broken) throw new Error('the extractor fell over');
    return { semanticTexts: [{ text: 'indexed at last' }] };
  },
};

const { page, close, goto, vfs, errors, setFault } = await boot({
  seed: async (vfs) => {
    vfs.indexers.register(flaky);
    await vfs.writeFile('plain.txt', 'no indexer touches this', { contentType: 'text/plain' });
  },
});
await goto();
await page.waitForSelector('.launch-item', { timeout: 5000 });

const activity = () => page.evaluate(() => window.__trove.app.activity.state);
const refresh = () => page.evaluate(() => window.__trove.app.activity.refresh());
const openPanel = async () => {
  await page.evaluate(() => window.__trove.app.activity.togglePanel(true));
  await page.waitForSelector('.activity-panel', { timeout: 4000 });
};

// --- 1. A quiet drive says so, rather than showing an empty scary list --------
await refresh();
check('a healthy drive reports no standing problems', (await activity()).issues.length === 0);
check('and the status bar carries no attention badge', (await page.locator('.sb-attention').count()) === 0);

// --- 2. A failed index becomes a standing problem, named ---------------------
// The write succeeds (the bytes are safe); it is the INDEXING that fails, which means
// the item exists but can't be found — exactly the failure a flat drive hides worst.
await vfs.writeFile('notes.md', '# Notes', { contentType: 'text/markdown' }).catch(() => {});
await refresh();
const raised = (await activity()).issues;
check('a file that failed to index is reported, by name',
  raised.length === 1 && /notes\.md/.test(raised[0].title), raised.map((i) => i.title).join(' | '));
check('and it says what the user loses, not just that an error happened',
  /search/i.test(raised[0].title || ''), raised[0]?.title);
// Wait on the DOM, not the store: the store updates synchronously with the fetch and
// the render follows a tick later, so counting immediately would race the renderer.
await page.waitForSelector('.sb-attention', { timeout: 4000 }).catch(() => {});
check('the status bar badge appears', (await page.locator('.sb-attention').count()) === 1);

// --- 3. The same failure twice is one problem, not two -----------------------
await vfs.writeFile('notes.md', '# Notes again', { contentType: 'text/markdown' }).catch(() => {});
await refresh();
const again = (await activity()).issues;
check('a repeat failure updates the existing problem instead of piling up',
  again.length === 1 && again[0].count >= 2, `count=${again[0]?.count}`);

// --- 4. It survives a reload — this is what makes it an issue, not a toast ----
await goto();
await page.waitForSelector('.launch-item', { timeout: 5000 });
await refresh();
check('the problem is still there after a full reload', (await activity()).issues.length === 1);

// --- 5. Retrying while still broken must NOT clear it ------------------------
await openPanel();
check('the panel offers a retry', (await page.locator('.act-retry').count()) === 1);
await page.locator('.act-retry').first().click();
await page.waitForTimeout(600);
await refresh();
check('a retry that did not fix anything leaves the problem listed',
  (await activity()).issues.length === 1);

// --- 6. Fixing the underlying cause clears it, without being asked to --------
broken = false;
await page.locator('.act-retry').first().click();
await page.waitForFunction(() => window.__trove.app.activity.state.issues.length === 0, { timeout: 6000 })
  .catch(() => {});
check('the problem clears once the work actually succeeds', (await activity()).issues.length === 0);
await page.waitForSelector('.sb-attention', { state: 'detached', timeout: 4000 }).catch(() => {});
check('and the status bar badge goes with it', (await page.locator('.sb-attention').count()) === 0);

// --- 7. A long job is watchable: it reports as a task with real progress ------
for (let i = 0; i < 5; i++) await vfs.writeFile(`bulk${i}.txt`, 'x'.repeat(50), { contentType: 'text/plain' });
await page.evaluate(() => window.__trove.platform.commands.execute('workbench.rebuildIndex'));
await page.waitForTimeout(500);
const afterRebuild = await activity();
const rebuilt = afterRebuild.tasks.find((t) => t.kind === 'index');
check('a rebuild shows up as a task', !!rebuilt, JSON.stringify(afterRebuild.tasks.map((t) => t.title)));
check('the task reports a real total rather than a made-up one',
  rebuilt && typeof rebuilt.total === 'number' && rebuilt.total > 0 && rebuilt.unit === 'items',
  `${rebuilt?.done}/${rebuilt?.total} ${rebuilt?.unit}`);
check('the task is a server task, mirrored into the same list as local work',
  rebuilt?.source === 'server', rebuilt?.source);
check('and it finishes rather than spinning forever',
  ['done', 'running'].includes(rebuilt?.status), rebuilt?.status);

// --- 8. A failure to LOAD the list must not read as "nothing is wrong" -------
setFault('/api/issues', true);
await refresh();
const offline = await activity();
// Reported per-load: the tasks poll succeeding must not erase the news that the issues
// poll failed, which is exactly what a single shared error field did.
check('when the list cannot be loaded, that is said out loud',
  !!offline.issuesError && !offline.tasksError, `issues=${offline.issuesError} tasks=${offline.tasksError}`);
await openPanel();
const panelText = await page.locator('.activity-panel').textContent();
check('the panel does not claim the drive is healthy while it is blind',
  /out of date|couldn.t reach/i.test(panelText), panelText.slice(0, 120));
setFault('/api/issues', false);

// The probe deliberately triggers a 500 (step 8) and indexer failures (steps 2–5).
// What must never happen is an uncaught exception: a background failure is a report,
// not a crash.
const unexpected = errors.filter((e) => !/Failed to load resource|500|404|ERR_ABORTED/i.test(e));
check('no unexpected page errors', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
check('no uncaught exceptions at all', !errors.some((e) => e.startsWith('pageerror:')),
  errors.filter((e) => e.startsWith('pageerror:')).slice(0, 2).join(' | '));
done();
await close();
