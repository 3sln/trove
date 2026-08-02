// Where a file's bytes come from, and which of them are kept.
//
// The rule this exists to protect: bytes are retained only for an item somebody actually
// asked to have offline. A plugin ranging over a 700 MB book nobody asked to keep must
// leave nothing behind, and that is not a nice-to-have — it is the difference between a
// viewer reading a file and a viewer silently filling the disk with it.

import { test, expect } from 'bun:test';
import { FileChunks, CHUNK_SIZE } from '../src/platform/fileChunks.js';

/**
 * A fake Cache Storage, so the tiering can be tested without a browser.
 *
 * Keys the way the real one does: a Request in, a Request out of `keys()`, and its URL is
 * the identity. That matters — chunk keys differ only in a query parameter, and the real
 * API strips a FRAGMENT from a Request's url, so a fake that keyed on the raw string would
 * have hidden every chunk colliding on the first one.
 */
function fakeCaches() {
  const stores = new Map();
  const urlOf = (key) => (typeof key === 'string' ? key : key.url ?? String(key));
  const store = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  globalThis.caches = {
    async open(name) {
      const map = store(name);
      return {
        async match(key) { return map.get(new Request(urlOf(key)).url) || null; },
        async put(key, res) { map.set(new Request(urlOf(key)).url, res); },
        async delete(key) { return map.delete(new Request(urlOf(key)).url); },
        async keys() { return [...map.keys()].map((url) => new Request(url)); },
      };
    },
  };
  return stores;
}

/** A drive holding one file, counting every range it is asked for. */
function fakeApi(size, { etag = 'v1' } = {}) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  const reads = [];
  return {
    bytes,
    reads,
    etag,
    async readRange(id, { start = 0, end } = {}) {
      const stop = end == null ? bytes.length : Math.min(end, bytes.length);
      reads.push([start, stop]);
      return { bytes: bytes.slice(start, stop), etag: this.etag, total: bytes.length };
    },
  };
}

const mediaUrls = { cacheKey: (id) => `https://drive.test/api/items/download?id=${id}` };
const settle = () => new Promise((r) => setTimeout(r, 10));

test('a file nobody asked to keep leaves nothing behind', async () => {
  const stores = fakeCaches();
  const api = fakeApi(10 * CHUNK_SIZE);
  const chunks = new FileChunks({ api, mediaUrls });

  const r = await chunks.read('itm_1', { start: 100, end: 200 });
  expect(r.bytes.length).toBe(100);
  expect(r.bytes[0]).toBe(api.bytes[100]);
  // Exactly the window asked for — not a chunk, not the file.
  expect(api.reads).toEqual([[100, 200]]);
  // And nothing stored. This is the assertion the whole design hangs off.
  expect(stores.get('trove-chunks-v1')).toBe(undefined);
});

test('once it is kept, a read contributes its chunks and a re-read costs nothing', async () => {
  fakeCaches();
  const api = fakeApi(3 * CHUNK_SIZE);
  const chunks = new FileChunks({ api, mediaUrls });

  await chunks.start('itm_1');
  chunks.cancel('itm_1'); // stop the background filler; this test is about the READ path
  api.reads.length = 0;

  const first = await chunks.read('itm_1', { start: CHUNK_SIZE + 10, end: CHUNK_SIZE + 20 });
  expect(first.bytes.length).toBe(10);
  // A whole chunk was fetched, because a whole chunk is what gets stored — playing from
  // the middle is what makes the middle worth keeping.
  expect(api.reads).toEqual([[CHUNK_SIZE, 2 * CHUNK_SIZE]]);

  api.reads.length = 0;
  const again = await chunks.read('itm_1', { start: CHUNK_SIZE + 15, end: CHUNK_SIZE + 25 });
  expect(again.bytes[0]).toBe(api.bytes[CHUNK_SIZE + 15]);
  expect(api.reads).toEqual([]); // served from what the first read left
});

test('a read spanning a chunk boundary is stitched back together', async () => {
  fakeCaches();
  const api = fakeApi(3 * CHUNK_SIZE);
  const chunks = new FileChunks({ api, mediaUrls });
  await chunks.start('itm_1');
  chunks.cancel('itm_1');

  const r = await chunks.read('itm_1', { start: CHUNK_SIZE - 5, end: CHUNK_SIZE + 5 });
  expect(r.bytes.length).toBe(10);
  expect([...r.bytes]).toEqual([...api.bytes.slice(CHUNK_SIZE - 5, CHUNK_SIZE + 5)]);
});

test('the background filler finishes the book, skipping what a seek already fetched', async () => {
  fakeCaches();
  const api = fakeApi(4 * CHUNK_SIZE);
  const chunks = new FileChunks({ api, mediaUrls });

  await chunks.start('itm_1');
  await settle();
  const done = chunks.status('itm_1');
  expect(done.done).toBe(true);
  expect(done.ratio).toBe(1);
  // Four chunks, each fetched once. A second filler racing the first would fetch every
  // chunk the other had not written yet — the whole file twice.
  const chunkReads = api.reads.filter(([a, b]) => b - a === CHUNK_SIZE);
  expect(chunkReads.length).toBe(4);
});

test('starting a running download returns its status rather than racing a second filler', async () => {
  fakeCaches();
  const api = fakeApi(2 * CHUNK_SIZE);
  const chunks = new FileChunks({ api, mediaUrls });
  const a = await chunks.start('itm_1');
  const b = await chunks.start('itm_1');
  await settle();
  expect(a.kept).toBe(true);
  expect(b.kept).toBe(true);
  expect(api.reads.filter(([s, e]) => e - s === CHUNK_SIZE).length).toBe(2);
});

test('a pinned whole-file copy answers first, with no network at all', async () => {
  const stores = fakeCaches();
  const api = fakeApi(2 * CHUNK_SIZE);
  const chunks = new FileChunks({ api, mediaUrls });
  // What bl/offline.js's `pin` leaves behind: the whole Response under the STABLE key.
  const pinned = new Response(api.bytes.slice(), { headers: { etag: 'v1' } });
  (await caches.open('trove-files-v1')).put(mediaUrls.cacheKey('itm_1'), pinned);

  const r = await chunks.read('itm_1', { start: 5, end: 15 });
  expect([...r.bytes]).toEqual([...api.bytes.slice(5, 15)]);
  expect(api.reads).toEqual([]);
  expect(stores.get('trove-chunks-v1')).toBe(undefined);
});

test('a file replaced under us drops what was stored rather than mixing two files', async () => {
  fakeCaches();
  const api = fakeApi(3 * CHUNK_SIZE);
  const chunks = new FileChunks({ api, mediaUrls });
  await chunks.start('itm_1');
  chunks.cancel('itm_1');
  await chunks.read('itm_1', { start: 0, end: 10 });

  // Somebody overwrites the file. It keeps its id, so an id-keyed cache would hand a
  // reader the head of the old file and the tail of the new one — which for a container
  // format is a parse failure, and a confusing one, because every byte is valid.
  api.etag = 'v2';
  for (let i = 0; i < api.bytes.length; i++) api.bytes[i] = (i + 7) % 251;
  api.reads.length = 0;

  const r = await chunks.read('itm_1', { start: CHUNK_SIZE, end: CHUNK_SIZE + 10 });
  expect([...r.bytes]).toEqual([...api.bytes.slice(CHUNK_SIZE, CHUNK_SIZE + 10)]);

  api.reads.length = 0;
  const reread = await chunks.read('itm_1', { start: 0, end: 10 });
  // Chunk 0 was stored under the OLD etag, so it is fetched again rather than served.
  expect(api.reads.length).toBe(1);
  expect([...reread.bytes]).toEqual([...api.bytes.slice(0, 10)]);
});

test('removing an item reclaims its bytes and stops it being kept', async () => {
  fakeCaches();
  const api = fakeApi(2 * CHUNK_SIZE);
  const chunks = new FileChunks({ api, mediaUrls });
  await chunks.start('itm_1');
  await settle();
  expect((await caches.open('trove-chunks-v1')).keys().then((k) => k.length)).resolves.toBe(2);

  await chunks.remove('itm_1');
  expect((await (await caches.open('trove-chunks-v1')).keys()).length).toBe(0);
  expect(chunks.status('itm_1').kept).toBe(false);

  // And it is a plain ranged reader again.
  api.reads.length = 0;
  await chunks.read('itm_1', { start: 0, end: 10 });
  expect(api.reads).toEqual([[0, 10]]);
});
