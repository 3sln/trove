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
    const url = await loadCover(ctxFor(bytes), { id: 'x' }, {
      range: { start: 10, end: 30 }, contentType: 'image/jpeg',
    });
    expect(url).toBe('blob:fake');
    // Exactly the bytes the indexer pointed at — not the whole file.
    expect(urls[0].size).toBe(20);
    expect(urls[0].type).toBe('image/jpeg');
  } finally { URL.createObjectURL = realCreate; }
});

test('a data: URL passes straight through, because it is already drawable', async () => {
  // The LPF case: a deflated cover has no bytes in the file to point at, so the indexer
  // carries it inline under a hard cap. CSP allows data: as well as blob:.
  const src = 'data:image/png;base64,AAAA';
  expect(await loadCover(ctxFor(new Uint8Array()), { id: 'x' }, { src })).toBe(src);
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
