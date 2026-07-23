// Drives the server through Web Requests end-to-end: capabilities, folder
// creation, a full direct multipart upload, download with a Range request, and
// search — all in-memory, no network.

import { test, expect } from 'bun:test';
import { createServer } from '../src/index.js';

async function jsonReq(handle, method, path, body) {
  const res = await handle(new Request(`http://t${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, res };
}

test('capabilities + health', async () => {
  const { handle } = await createServer();
  const h = await jsonReq(handle, 'GET', '/api/health');
  expect(h.json.ok).toBe(true);
  const caps = await jsonReq(handle, 'GET', '/api/capabilities');
  expect(caps.json.storage.multipart).toBe(true);
  expect(caps.json.features.semanticSearch).toBe(true);
});

test('folder + upload + download + range + search', async () => {
  const { handle } = await createServer();

  const folder = await jsonReq(handle, 'POST', '/api/fs/folder', { parentId: 'root', name: 'books' });
  expect(folder.json.node.path).toBe('/books');

  const content = 'Dune is a science fiction novel about desert planet Arrakis and spice.';
  const size = new TextEncoder().encode(content).length;
  const plan = await jsonReq(handle, 'POST', '/api/uploads', {
    parentId: folder.json.node.id, name: 'dune.txt', size, contentType: 'text/plain',
  });
  expect(plan.json.strategy).toBe('direct');

  // Upload the single part directly.
  const putRes = await handle(new Request(`http://t/api/uploads/${plan.json.uploadId}/parts/1`, {
    method: 'PUT', body: content,
  }));
  expect(putRes.status).toBe(200);

  const done = await jsonReq(handle, 'POST', `/api/uploads/${plan.json.uploadId}/complete`, {});
  const fileId = done.json.node.id;
  expect(done.json.node.size).toBe(size);

  // Full download.
  const dl = await handle(new Request(`http://t/api/fs/download?id=${fileId}`));
  expect(dl.status).toBe(200);
  expect(await dl.text()).toBe(content);

  // Range download → 206.
  const ranged = await handle(new Request(`http://t/api/fs/download?id=${fileId}`, {
    headers: { range: 'bytes=0-3' },
  }));
  expect(ranged.status).toBe(206);
  expect(ranged.headers.get('content-range')).toContain(`/${size}`);
  expect(await ranged.text()).toBe('Dune');

  // Search (keyword hits the indexed content).
  const search = await jsonReq(handle, 'GET', '/api/search?q=spice%20desert');
  expect(search.json.results[0].node.name).toBe('dune.txt');
});

test('plugin indexer pushes namespaced docs', async () => {
  const { handle, vfs } = await createServer();
  const file = await vfs.writeFile('root', 'photo.jpg', new Uint8Array([1, 2, 3]), { contentType: 'image/jpeg' });
  const idx = await jsonReq(handle, 'POST', '/api/index/plugin.vision', {
    nodeId: file.id,
    documents: [{ text: 'a golden retriever puppy playing on green grass in a park' }],
    facet: { labels: ['dog', 'grass', 'park'] },
  });
  expect(idx.json.ok).toBe(true);
  const search = await jsonReq(handle, 'GET', '/api/search?q=puppy%20park');
  expect(search.json.results.some((r) => r.node.name === 'photo.jpg')).toBe(true);
});
