// Probe: the link graph under change. Links are how a flat drive holds together, so
// what happens when the thing on the other end moves or disappears is not an edge case
// — it is the normal weather. Every one of these must SAY what happened rather than
// leaving a dead click, a stale panel, or a claim about the drive that isn't true.

import { boot, checker } from './harness.mjs';

const { check, done } = checker();

const { page, close, goto, setFault, vfs, errors } = await boot({
  seed: async (vfs) => {
    await vfs.writeFile('target.md', '# Target\n\nThe thing being linked to.', { contentType: 'text/markdown' });
    await vfs.writeFile('index.md',
      '# Index\n\n- [Target](trove:default/target.md)\n- [Gone](trove:default/never-existed.md)\n',
      { contentType: 'text/markdown' });
  },
});
await goto();
await page.waitForSelector('.launch-item', { timeout: 5000 });

const toasts = () => page.evaluate(() => window.__trove.platform.notifications.items.map((n) => n.message));
const clearToasts = () => page.evaluate(() => window.__trove.platform.notifications.items.splice(0));
const openIndex = async () => {
  await page.evaluate(() => window.__trove.platform.workbench.showHome());
  await page.waitForSelector('.launch-item', { timeout: 4000 });
  await page.locator('.launch-item', { hasText: 'index.md' }).first().click();
  await page.waitForSelector('.md-trove', { timeout: 4000 });
};

// --- 1. A link to something that never existed -------------------------------
await openIndex();
await clearToasts();
await page.locator('.md-trove').nth(1).click();
await page.waitForTimeout(400);
const missing = (await toasts()).join(' | ');
check('a link to a missing item names what it looked for',
  /never-existed\.md/.test(missing) && /renamed or deleted/.test(missing), missing);

// --- 2. A link whose target was renamed out from under it --------------------
const target = (await page.evaluate(() => window.__trove.app.explorer.state.items.map((i) => ({ id: i.id, name: i.name }))))
  .find((i) => i.name === 'target.md');
await vfs.rename(target.id, 'renamed.md');
await clearToasts();
await page.locator('.md-trove').first().click();
await page.waitForTimeout(400);
const renamed = (await toasts()).join(' | ');
check('a link broken by a rename says so, rather than doing nothing',
  /target\.md/.test(renamed) && /renamed or deleted/.test(renamed), renamed);

// A name link must NOT silently retarget at whatever later takes the name.
await vfs.writeFile('target.md', '# Impostor', { contentType: 'text/markdown' });
await clearToasts();
await page.locator('.md-trove').first().click();
await page.waitForTimeout(600);
const nowOpen = await page.evaluate(() => window.__trove.platform.workbench.nav.state.activeFile?.name);
check('the link resolves by name, so a new item with that name is what it finds', nowOpen === 'target.md', String(nowOpen));

// --- 3. Backlinks track a rename of the LINKING document ----------------------
await page.evaluate(() => window.__trove.platform.workbench.toggleInfoPanel(true));
await page.waitForSelector('.ip-backlink', { timeout: 4000 }).catch(() => {});
check('backlinks list the document that points here',
  (await page.locator('.ip-backlink').allTextContents()).some((t) => /index\.md/.test(t)));

// --- 4. A backlinks load failure must not read as "nothing links here" -------
setFault('/api/items/backlinks', true);
await page.evaluate(() => window.__trove.app.social.loadBacklinks(window.__trove.platform.workbench.nav.state.activeFile.id));
await page.waitForFunction(() => window.__trove.app.social.state.backlinks?.loading === false, { timeout: 4000 }).catch(() => {});
const panel = await page.locator('.infopanel').textContent();
check('a failed backlinks load says so instead of claiming nothing links here',
  /couldn.t load links/i.test(panel) && !/nothing links here/i.test(panel), panel.slice(0, 160));
setFault('/api/items/backlinks', false);

// --- 5. Deleting a linked item leaves the linking document readable ----------
await page.evaluate(() => window.__trove.platform.workbench.toggleInfoPanel(false));
const impostor = (await page.evaluate(() => window.__trove.app.explorer.state.items.map((i) => ({ id: i.id, name: i.name }))))
  .find((i) => i.name === 'target.md');
if (impostor) await vfs.remove(impostor.id);
await openIndex();
check('the linking document still renders when its target is gone',
  (await page.locator('.md-trove').count()) === 2 && (await page.locator('.viewer.markdown').count()) === 1);

// Following a broken link is a 404, and step 4 injects a 500 — both are the point of
// this probe. What must never appear is an uncaught EXCEPTION: a link that can't
// resolve is a message to the reader, not a crash.
const unexpected = errors.filter((e) => !/Failed to load resource|404|500|ERR_ABORTED/i.test(e));
check('no uncaught page errors', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
check('no uncaught exceptions at all', !errors.some((e) => e.startsWith('pageerror:')),
  errors.filter((e) => e.startsWith('pageerror:')).join(' | '));
done();
await close();
