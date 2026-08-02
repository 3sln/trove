// Getting the cover onto the screen, inside a sandbox that forbids remote loads.
//
// The frame's CSP is `img-src blob: data:` and `connect-src 'none'` — see
// pluginFrames.js — so a viewer cannot fetch a picture and cannot point an <img> at one.
// Everything it draws has to arrive as bytes over the port and become a blob: URL here.
// That is the same constraint that stopped the audio working, and it is why this function
// exists rather than the player just using a URL.

import { test, expect } from 'bun:test';
import { loadCover } from '../src/loadCover.js';

const ctxFor = (bytes) => ({
  files: {
    blob: async () => ({
      slice: (start, end) => ({ bytes: async () => bytes.subarray(start, end) }),
    }),
  },
});

test('a range is read through the ranged reader and becomes a blob URL', async () => {
  const bytes = new Uint8Array(100).fill(7);
  const urls = [];
  const realCreate = URL.createObjectURL;
  URL.createObjectURL = (blob) => { urls.push(blob); return 'blob:fake'; };
  try {
    const out = await loadCover(ctxFor(bytes), { id: 'x' }, {
      range: { start: 10, end: 30 }, contentType: 'image/jpeg',
    });
    expect(out.url).toBe('blob:fake');
    // Exactly the bytes the indexer pointed at — not the whole file.
    expect(urls[0].size).toBe(20);
    expect(urls[0].type).toBe('image/jpeg');
  } finally { URL.createObjectURL = realCreate; }
});

test('a data: URL passes straight through, because it is already drawable', async () => {
  // The LPF case: a deflated cover has no bytes in the file to point at, so the indexer
  // carries it inline under a hard cap. CSP allows data: as well as blob:.
  const src = 'data:image/png;base64,AAAA';
  // Both forms, because a data: URL is drawable here AND loadable by the host.
  expect(await loadCover(ctxFor(new Uint8Array()), { id: 'x' }, { src })).toEqual({ url: src, artwork: src });
});

test('a missing or malformed cover is null, never a thrown open', async () => {
  const ctx = ctxFor(new Uint8Array(10));
  expect(await loadCover(ctx, { id: 'x' }, null)).toBe(null);
  expect(await loadCover(ctx, { id: 'x' }, {})).toBe(null);
  expect(await loadCover(ctx, { id: 'x' }, { range: { start: 0 } })).toBe(null);
  // A read that throws is a book without a cover, not a book that will not open.
  const broken = { files: { blob: async () => { throw new Error('offline'); } } };
  expect(await loadCover(broken, { id: 'x' }, { range: { start: 0, end: 4 } })).toBe(null);
});

test('the cover comes back in two forms, because the host cannot load the frame’s', async () => {
  // The bug: media-session artwork was the frame's object URL. A sandboxed frame is on an
  // OPAQUE origin, so its object URLs are `blob:null/…` and the host page — which is what
  // actually sets `navigator.mediaSession` — cannot load one. Chrome refuses it as "Not
  // allowed to load local resource" against a document that never mentions the plugin,
  // and the lock-screen image simply never appears.
  //
  // There is no version where a frame mints a URL the host can use, so artwork crosses as
  // bytes instead.
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const realCreate = URL.createObjectURL;
  URL.createObjectURL = () => 'blob:null/fake';
  try {
    const out = await loadCover(ctxFor(bytes), { id: 'x' }, {
      range: { start: 0, end: 8 }, contentType: 'image/jpeg',
    });
    // Drawn in the frame: an object URL, which costs nothing and needs no copy.
    expect(out.url).toBe('blob:null/fake');
    // Sent to the host: bytes it can actually load.
    expect(out.artwork.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(atob(out.artwork.split(',')[1])).toBe(String.fromCharCode(...bytes));
    // And never a blob, which the host now refuses outright.
    expect(out.artwork).not.toMatch(/^blob:/);
  } finally { URL.createObjectURL = realCreate; }
});

test('a data: cover is already both forms', async () => {
  const src = 'data:image/png;base64,AAAA';
  const out = await loadCover(ctxFor(new Uint8Array()), { id: 'x' }, { src });
  expect(out).toEqual({ url: src, artwork: src });
});
