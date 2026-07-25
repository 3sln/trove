// Probe: openers with missing/broken bytes. A metadata node whose storageKey points
// at nothing → the download URL 404s. Do the image/video/audio openers surface an
// error, or silently show a broken element?

import { boot, checker } from './harness.mjs';

const { check, done } = checker();

const { page, vfs, errors, close, goto } = await boot({
  seed: async (vfs) => {
    await vfs.writeFile('root', 'readme.txt', 'hello world', { contentType: 'text/plain' });
    // Files whose bytes are absent (bogus storageKey) — metadata exists, content 404s.
    await vfs.metadata.create({ parentId: 'root', name: 'broken.png', kind: 'file', storageKey: 'nope-img', size: 100, contentType: 'image/png' });
    await vfs.metadata.create({ parentId: 'root', name: 'broken.mp4', kind: 'file', storageKey: 'nope-vid', size: 100, contentType: 'video/mp4' });
    await vfs.metadata.create({ parentId: 'root', name: 'broken.mp3', kind: 'file', storageKey: 'nope-aud', size: 100, contentType: 'audio/mpeg' });
    await vfs.metadata.create({ parentId: 'root', name: 'broken-text.txt', kind: 'file', storageKey: 'nope-txt', size: 100, contentType: 'text/plain' });
  },
});

await goto();
await page.waitForSelector('.launcher .launch-item', { timeout: 5000 });

async function open(name) {
  // Return to launcher if a viewer is up.
  if (await page.locator('.viewer-nav .vn-back').count()) {
    await page.locator('.viewer-nav .vn-back').first().click();
    await page.waitForSelector('.launcher .launch-input', { timeout: 3000 });
  }
  await page.locator('.launch-item', { hasText: name }).first().click();
  await page.waitForTimeout(1200); // let the element attempt to load + fail
}

// A viewer "gave feedback" if there's a visible fallback/error message.
async function hasErrorFeedback() {
  const fallback = await page.locator('.viewer .fallback, .viewer .error, .viewer .viewer-error').count();
  return fallback > 0;
}

await open('broken-text.txt');
check('text opener shows an error when bytes are missing', await hasErrorFeedback());

await open('broken.png');
check('image opener shows feedback when bytes are missing', await hasErrorFeedback(),
  await page.locator('.viewer').innerHTML().catch(() => '').then((h) => (h || '').slice(0, 80)));

await open('broken.mp4');
check('video opener shows feedback when bytes are missing', await hasErrorFeedback());

await open('broken.mp3');
check('audio opener shows feedback when bytes are missing', await hasErrorFeedback());

// The broken files are SUPPOSED to 404 — that's the whole probe. Only flag errors
// unrelated to those expected download failures.
// ERR_ABORTED too: swapping the broken media element out for the fallback cancels its
// in-flight request — that's the fix working, not a fault.
const unexpected = errors.filter((e) => !/nope-(img|vid|aud|txt)|404|Failed to load resource|Download failed|watched observable|ERR_ABORTED/i.test(e));
check('no unexpected page errors', unexpected.length === 0, unexpected.slice(0, 5).join(' | '));

done();
await close();
