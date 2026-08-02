// Probe: URLs that carry their own authorization, and what happens when they expire.
//
// The half that is easy to get right is minting one. The half that gets skipped is
// CYCLING: a URL dies, and replacing it under a playing video is not a matter of
// assigning `src`. Record where the user was, load, seek back, resume — miss any step
// and the film restarts from the beginning, or sits there paused looking like a crash.
//
// The server is booted with a very short media TTL so expiry happens in seconds instead
// of hours. Nothing else about the app is told; the client's cycling has no idea it is
// being hurried along, which is the point.

import { boot, checker } from './harness.mjs';

const { check, done } = checker();

// Long enough that the refresh lands while it is still playing — the case under test.
// At 0.3s the clip ended before the first cycle fired, so the check was measuring a
// finished element and would have passed a cycling implementation that lost its place.
function wav(seconds = 8, rate = 8000) {
  const n = Math.floor(seconds * rate);
  const buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write('data', 36); buf.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) buf[44 + i] = 128 + Math.round(40 * Math.sin(i / 12));
  return buf;
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const { page, close, goto, errors } = await boot({
  serverConfig: { urlSecret: 'probe-secret' },
  seed: async (vfs) => {
    await vfs.writeFile('tone.wav', wav(), { contentType: 'audio/wav' });
    for (const n of ['alps', 'boat', 'cliff', 'dune']) {
      await vfs.writeFile(`${n}.png`, PNG, { contentType: 'image/png' });
    }
  },
});
await goto();
await page.waitForSelector('.launch-item, .grid-tile', { timeout: 8000 });

// --- 1. Nothing is minted when the browser can authenticate itself -------------
// The default deployment is cookie/proxy authenticated, so the plain route URL works and
// minting would be a round trip per tile bought for nothing.
const unminted = await page.evaluate(async () => {
  const t = window.__trove;
  const item = t.app.explorer.get().items.find((i) => i.name === 'alps.png');
  const got = await t.platform.mediaUrls.url(item.id);
  return { needed: t.platform.mediaUrls.needed, url: got.url, expiresAt: got.expiresAt };
});
check('with no bearer token nothing is minted, and nothing expires',
  unminted.needed === false && !unminted.url.includes('sig=') && unminted.expiresAt === Infinity,
  JSON.stringify({ ...unminted, expiresAt: String(unminted.expiresAt) }));

// --- 2. A minted URL fetches with no credentials at all ------------------------
const minted = await page.evaluate(async () => {
  const t = window.__trove;
  const item = t.app.explorer.get().items.find((i) => i.name === 'alps.png');
  const res = await t.platform.api.mintUrls([item.id], 'media');
  const url = res.urls[item.id].url;
  // A bare fetch: no Authorization header, no credentials — exactly what an <img src>
  // sends. That it works is the entire feature.
  const bytes = await fetch(url, { credentials: 'omit' });
  return { url, ok: bytes.ok, size: (await bytes.arrayBuffer()).byteLength };
});
check('a minted URL fetches the bytes with no credentials on the request',
  minted.ok && minted.size > 0 && minted.url.includes('sig='), JSON.stringify(minted));

// --- 3. Tampering with one is refused ------------------------------------------
const tampered = await page.evaluate(async (u) => {
  const url = new URL(u, location.origin);
  const bump = (k, v) => { const c = new URL(url); c.searchParams.set(k, v); return c.toString(); };
  const status = async (x) => (await fetch(x, { credentials: 'omit' })).status;
  return {
    extended: await status(bump('exp', String(Number(url.searchParams.get('exp')) + 99999))),
    forged: await status(bump('sig', 'A'.repeat(43))),
  };
}, minted.url);
check('an edited expiry or a forged signature is refused',
  tampered.extended === 403 && tampered.forged === 403, JSON.stringify(tampered));

// --- 4. A batch is one request, however many tiles ------------------------------
const batched = await page.evaluate(async () => {
  const t = window.__trove;
  const ids = t.app.explorer.get().items.filter((i) => i.name.endsWith('.png')).map((i) => i.id);
  let calls = 0;
  // Count the API call itself: the client captured `fetch` at construction, so patching
  // `window.fetch` here would count nothing and pass for the wrong reason.
  const realMint = t.platform.api.mintUrls.bind(t.platform.api);
  t.platform.api.mintUrls = (...a) => { calls++; return realMint(...a); };
  // `always` is the real setting a proxy-authenticated deployment would use to push
  // media straight at storage — not a test hook.
  t.platform.settings.set('media.signedUrls', 'always');
  t.platform.mediaUrls.invalidate();
  // Asked for in the same tick, as a grid's tiles are.
  const got = await Promise.all(ids.map((id) => t.platform.mediaUrls.url(id)));
  t.platform.api.mintUrls = realMint;
  t.platform.settings.set('media.signedUrls', 'auto');
  return { ids: ids.length, calls, urls: got.filter((g) => g.url.includes('sig=')).length };
});
check('a wall of tiles costs one mint request, not one each',
  batched.ids >= 4 && batched.calls === 1 && batched.urls === batched.ids, JSON.stringify(batched));

// --- 5. Cycling: the URL expires mid-playback and the sound keeps going ---------
// The whole point. A short-lived grant is put on a playing <audio>, allowed to expire,
// and the element must recover WITHOUT losing its place or stopping.
const cycled = await page.evaluate(async () => {
  const t = window.__trove;
  const item = t.app.explorer.get().items.find((i) => i.name === 'tone.wav');
  const urls = t.platform.mediaUrls;

  // A deployment that mints, and a TTL short enough that "hours later" happens in two
  // seconds. Only the clock is faked; the minting and the cycling are the real ones.
  t.platform.settings.set('media.signedUrls', 'always');
  const seen = [];
  urls.url = async (id) => {
    const res = await t.platform.api.mintUrls([id], 'media');
    const url = res.urls[id].url;
    seen.push(url);
    return { url, expiresAt: Date.now() + 3000 };
  };
  urls.invalidate = () => {};

  const el = document.createElement('audio');
  el.controls = true;
  document.body.appendChild(el);
  const detach = t.test.attachMedia(el, { id: item.id, contentType: 'audio/wav' }, { platform: t.platform }, {});

  await new Promise((r) => el.addEventListener('loadedmetadata', r, { once: true }));
  await el.play().catch(() => {});
  // Let it get WELL into the clip before the refresh. Sampling at 120ms made the check
  // meaningless: a swap that restarted from zero would still have played more than 120ms
  // by the time it was measured, so `after > before` passed on a broken implementation.
  await new Promise((r) => setTimeout(r, 2000));
  const before = { time: el.currentTime, playing: !el.paused, src: el.src };

  // Past the refresh point (80% of 3000ms) and then some.
  await new Promise((r) => setTimeout(r, 1300));
  const after = { time: el.currentTime, playing: !el.paused, src: el.src, ended: el.ended };

  detach();
  el.remove();
  t.platform.settings.set('media.signedUrls', 'auto');
  return { seen: seen.length, before, after, distinct: new Set(seen).size };
});
check('an expiring URL is replaced before it dies', cycled.seen >= 2, JSON.stringify(cycled.seen));
check('and each replacement is a genuinely new grant', cycled.distinct >= 2, JSON.stringify(cycled));
// Strictly ahead of where it was, not merely non-zero: a swap that restarts from the
// beginning still accumulates playback time, so only continuity distinguishes them.
check('the swap keeps its place rather than restarting from the beginning',
  cycled.after.time > cycled.before.time, JSON.stringify(cycled));
check('and it is still playing afterwards, not silently paused',
  cycled.after.playing || cycled.after.ended, JSON.stringify(cycled));

// --- 6. Detaching stops the cycle -----------------------------------------------
// A timer that outlives its element re-mints forever against a node nobody is looking at.
const stopped = await page.evaluate(async () => {
  const t = window.__trove;
  const item = t.app.explorer.get().items.find((i) => i.name === 'tone.wav');
  let mints = 0;
  const urls = t.platform.mediaUrls;
  urls.url = async () => { mints++; return { url: t.platform.api.downloadUrl(item.id), expiresAt: Date.now() + 800 }; };
  const el = document.createElement('audio');
  document.body.appendChild(el);
  const detach = t.test.attachMedia(el, { id: item.id }, { platform: t.platform }, {});
  await new Promise((r) => setTimeout(r, 100));
  detach();
  const afterDetach = mints;
  await new Promise((r) => setTimeout(r, 1500));
  el.remove();
  return { afterDetach, now: mints };
});
check('detaching stops the cycle rather than leaving a timer minting forever',
  stopped.now === stopped.afterDetach, JSON.stringify(stopped));

// --- 7. Offline pins key on something stable ------------------------------------
// `pin` stores under a key and `unpin` looks it up again, possibly in another session.
// A minted URL carries a signature and is different every time, so keying on one would
// work exactly once and then leak the bytes forever.
const keys = await page.evaluate(async () => {
  const t = window.__trove;
  const item = t.app.explorer.get().items.find((i) => i.name === 'alps.png');
  const urls = t.platform.mediaUrls;
  const k1 = urls.cacheKey(item.id);
  urls.invalidate();
  const k2 = urls.cacheKey(item.id);
  const minted1 = (await t.platform.api.mintUrls([item.id], 'media')).urls[item.id].url;
  const minted2 = (await t.platform.api.mintUrls([item.id], 'media')).urls[item.id].url;
  return { k1, k2, stable: k1 === k2, mintedStable: minted1 === minted2, keyIsPlain: !k1.includes('sig=') };
});
check('the offline cache key is stable across mints, and is not a signed URL',
  keys.stable && keys.keyIsPlain, JSON.stringify(keys));

const real = errors.filter((e) => !e.includes('net::ERR_ABORTED') && !e.includes('403'));
check('no uncaught errors along the way', real.length === 0, real.slice(0, 4).join(' | '));
done();
await close();
