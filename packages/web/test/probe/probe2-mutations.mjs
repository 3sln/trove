// Probe: mutation error paths surface feedback (toasts), and destructive edge cases
// don't corrupt UI state. Name collision on upload, rename onto an existing name, delete a file
// that's currently open, and an upload-name collision (disambiguation notice).

import { boot, checker } from './harness.mjs';

const { check, done } = checker();

const { page, vfs, errors, close, goto } = await boot({
  seed: async (vfs) => {
    await vfs.writeFile('alpha.txt', 'first', { contentType: 'text/plain' });
    await vfs.writeFile('beta.txt', 'second', { contentType: 'text/plain' });
    await vfs.writeFile('existing.txt', 'third', { contentType: 'text/plain' });
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

// 1. An upload onto a taken name must NOT clobber it — the server negotiates a free
// name, and the client says so rather than letting a file vanish silently.
const dropped = await run(async () => {
  const app = window.__trove.app;
  const blob = new File(['replacement'], 'existing.txt', { type: 'text/plain' });
  const node = await app.platform.api.upload(blob, { collection: 'default' });
  return node?.name;
});
check('an upload onto a taken name is renamed, not overwritten', dropped === 'existing (1).txt', String(dropped));

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
    // `platform.workbench.closeTab?.()` until now — a name that has not existed since the
    // workbench facade was dissolved, so the `?.` turned the half of this probe that
    // matters into a no-op. It is navigation's, and it is called `forget`.
    app.platform.navigation.forget(id);
  }, opened);
  await page.waitForTimeout(300);
}
check('deleting an open file does not throw an uncaught error',
  opened && errors.filter((e) => /pageerror/.test(e)).length === 0, errors.filter((e) => /pageerror/.test(e))[0] || (opened ? '' : 'alpha.txt not found'));

// 4. Upload-name collision → disambiguation notice (info toast), original untouched.
const dupInfo = await run(async () => {
  const app = window.__trove.app;
  const blob = new File([new Uint8Array([1, 2, 3])], 'beta.txt', { type: 'text/plain' });
  const node = await app.platform.api.upload(blob, { collection: 'default' });
  return node?.name;
});
check('upload onto existing name is disambiguated (non-destructive)', dupInfo === 'beta (1).txt', String(dupInfo));

check('no uncaught page errors', errors.filter((e) => /pageerror/.test(e)).length === 0,
  errors.filter((e) => /pageerror/.test(e)).slice(0, 3).join(' | '));

done();
await close();
