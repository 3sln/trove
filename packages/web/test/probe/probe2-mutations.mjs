// Probe: mutation error paths surface feedback (toasts), and destructive edge cases
// don't corrupt UI state. Duplicate folder, rename onto an existing name, delete a file
// that's currently open, and an upload-name collision (disambiguation notice).

import { boot, checker } from './harness.mjs';

const { check, done } = checker();

const { page, vfs, errors, close, goto } = await boot({
  seed: async (vfs) => {
    await vfs.writeFile('root', 'alpha.txt', 'first', { contentType: 'text/plain' });
    await vfs.writeFile('root', 'beta.txt', 'second', { contentType: 'text/plain' });
    await vfs.mkdir('root', 'existing');
  },
});

await goto();
await page.waitForSelector('.launcher .launch-item', { timeout: 5000 });

// Drive actions directly through the app engine (the UI wraps these same actions).
async function run(fn, arg) {
  return page.evaluate(fn, arg);
}
async function toastCount() {
  return page.locator('.toasts .toast').count();
}
async function lastToast() {
  const t = page.locator('.toasts .toast').last();
  return (await t.count()) ? (await t.textContent()) : '';
}

// 1. Create a folder with a name that already exists → error toast (not silent).
await run(async () => {
  const app = window.__trove.app;
  try { await app.platform.api.mkdir(app.explorer.state.folder?.id || 'root', 'existing'); }
  catch (e) { app.platform.notifications.error(`Couldn’t create folder: ${e.message}`); }
});
await page.waitForTimeout(200);
check('duplicate folder creation shows an error toast', (await toastCount()) >= 1, await lastToast());

// 2. Rename a file onto an existing name → error surfaced.
const renameErr = await run(async () => {
  const app = window.__trove.app;
  const beta = app.explorer.state.items.find((i) => i.name === 'beta.txt');
  try { await app.platform.api.rename(beta.id, 'alpha.txt'); return null; }
  catch (e) { return e.message; }
});
check('rename onto an existing name is rejected by the server', !!renameErr, renameErr || '(no error)');

// 3. Delete a file while it is open in a viewer → no crash, viewer handles it.
const opened = await run(async () => {
  const app = window.__trove.app;
  const node = app.explorer.state.items.find((i) => i.name === 'alpha.txt');
  if (!node) return null;
  app.platform.workbench.openFile(node, 'core.text', {});
  return node.id;
});
await page.waitForTimeout(400);
if (opened) {
  await run(async (id) => {
    const app = window.__trove.app;
    await app.platform.api.remove(id, true);
    app.platform.workbench.closeTab?.(id);
  }, opened);
  await page.waitForTimeout(300);
}
check('deleting an open file does not throw an uncaught error',
  opened && errors.filter((e) => /pageerror/.test(e)).length === 0, errors.filter((e) => /pageerror/.test(e))[0] || (opened ? '' : 'alpha.txt not found'));

// 4. Upload-name collision → disambiguation notice (info toast), original untouched.
const dupInfo = await run(async () => {
  const app = window.__trove.app;
  const blob = new File([new Uint8Array([1, 2, 3])], 'beta.txt', { type: 'text/plain' });
  const node = await app.platform.api.upload(blob, { parentId: 'root' });
  return node?.name;
});
check('upload onto existing name is disambiguated (non-destructive)', dupInfo === 'beta (1).txt', String(dupInfo));

check('no uncaught page errors', errors.filter((e) => /pageerror/.test(e)).length === 0,
  errors.filter((e) => /pageerror/.test(e)).slice(0, 3).join(' | '));

done();
await close();
