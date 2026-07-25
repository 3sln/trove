// Probe: uninstalling an ACCOUNT plugin whose server-side removal fails must NOT
// silently drop it locally (it would resurrect on next reload) — it must surface an
// error and keep the plugin. Then a successful uninstall really removes it.

import { boot, checker } from './harness.mjs';
import { buildPackage } from '../pluginFixture.mjs';

const { check, done } = checker();

const { page, close, goto, setFault } = await boot();
await goto();

const { zip } = await buildPackage(); // account-scoped (declares storage)
const b64 = Buffer.from(zip).toString('base64');

const pluginId = await page.evaluate(async (data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const pkg = window.__trove.test.parsePackage(bytes);
  await window.__trove.test.install(pkg, {}); // grants default to all declared
  return pkg.manifest.id;
}, b64);

await page.waitForFunction((id) => window.__trove.platform.plugins.list().some((p) => p.id === id && p.status === 'active'), pluginId, { timeout: 8000 });
check('account plugin installed & active', true, pluginId);

// It's on the server too.
const onServer = await page.evaluate(async () => (await window.__trove.platform.api.installedPlugins()).plugins.length);
check('account plugin uploaded to the server', onServer >= 1, `server has ${onServer}`);

// Break the server-side uninstall, then try to uninstall.
setFault(`${pluginId}/install`, true);
const toastsBefore = await page.locator('.toasts .toast').count();
await page.evaluate((id) => window.__trove.platform.plugins.uninstall(id), pluginId);
await page.waitForTimeout(600);

check('a failed server uninstall shows an error toast',
  (await page.locator('.toasts .toast.error').count()) >= 1 || (await page.locator('.toasts .toast').count()) > toastsBefore);
const stillThere = await page.evaluate((id) => window.__trove.platform.plugins.list().some((p) => p.id === id), pluginId);
check('the plugin is KEPT (not silently dropped → would resurrect)', stillThere);

// Recover, uninstall for real.
setFault(`${pluginId}/install`, false);
await page.evaluate((id) => window.__trove.platform.plugins.uninstall(id), pluginId);
await page.waitForTimeout(600);
const gone = await page.evaluate((id) => !window.__trove.platform.plugins.list().some((p) => p.id === id), pluginId);
check('a successful uninstall removes the plugin', gone);
const serverAfter = await page.evaluate(async () => (await window.__trove.platform.api.installedPlugins()).plugins.length);
check('and removes it from the server', serverAfter === 0, `server has ${serverAfter}`);

done();
await close();
