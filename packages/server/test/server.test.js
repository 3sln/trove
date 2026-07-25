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

test('plugin storage SQL: scoped round-trip + ATTACH rejected', async () => {
  const { handle } = await createServer();
  const sql = (op, extra) => jsonReq(handle, 'POST', '/api/plugins/com.acme.demo/sql', { op, ...extra });

  // Create + write + read back in the plugin's private scope.
  expect((await sql('exec', { sql: 'CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)' })).json.result.ok).toBe(true);
  await sql('run', { sql: 'INSERT INTO kv VALUES (?,?)', params: ['a', '1'] });
  const got = await sql('get', { sql: 'SELECT v FROM kv WHERE k=?', params: ['a'] });
  expect(got.json.result.v).toBe('1');

  // A different plugin id is a different database (isolation).
  const other = await jsonReq(handle, 'POST', '/api/plugins/com.acme.other/sql', { op: 'all', sql: 'SELECT v FROM kv' });
  expect(other.status).toBeGreaterThanOrEqual(400); // no such table in the other scope

  // ATTACH is refused (would escape the isolated db on a shared filesystem).
  const attach = await sql('exec', { sql: "ATTACH DATABASE 'x.db' AS y" });
  expect(attach.status).toBeGreaterThanOrEqual(400);

  // An unknown op is rejected.
  expect((await sql('drop_table', { sql: 'x' })).status).toBeGreaterThanOrEqual(400);
});

test('adding a tag exposes it in the node\'s merged tags (filterable)', async () => {
  const { handle, vfs } = await createServer();
  const folder = await vfs.mkdir('root', 'tagged');
  const file = await vfs.writeFile(folder.id, 'x.txt', 'hi', { contentType: 'text/plain' });
  await jsonReq(handle, 'POST', `/api/files/${file.id}/tags`, { name: 'fav', value: 'yes' });
  const list = await jsonReq(handle, 'GET', `/api/fs/list?id=${folder.id}`);
  const row = list.json.items.find((n) => n.id === file.id);
  expect(row.tags.fav).toBe('yes'); // merged view
  expect(row.contributions.user.tags.fav).toBe('yes'); // namespaced under the 'user' scope

  await jsonReq(handle, 'DELETE', `/api/files/${file.id}/tags/fav`);
  const after = await jsonReq(handle, 'GET', `/api/fs/list?id=${folder.id}`);
  expect(after.json.items.find((n) => n.id === file.id).tags.fav).toBeFalsy(); // removed reads as absent
});

test('move + rename relocate a node and update its path', async () => {
  const { handle, vfs } = await createServer();
  const from = await jsonReq(handle, 'POST', '/api/fs/folder', { parentId: 'root', name: 'from' });
  const to = await jsonReq(handle, 'POST', '/api/fs/folder', { parentId: 'root', name: 'to' });
  const node = await vfs.writeFile(from.json.node.id, 'notes.txt', 'hello', { contentType: 'text/plain' });
  expect(node.path).toBe('/from/notes.txt');

  const moved = await jsonReq(handle, 'POST', '/api/fs/move', { id: node.id, destParentId: to.json.node.id });
  expect(moved.status).toBe(200);
  expect(moved.json.node.path).toBe('/to/notes.txt');

  const renamed = await jsonReq(handle, 'POST', '/api/fs/rename', { id: node.id, newName: 'renamed.txt' });
  expect(renamed.json.node.path).toBe('/to/renamed.txt');

  // The old location no longer lists it; the new one does.
  const listFrom = await jsonReq(handle, 'GET', `/api/fs/list?id=${from.json.node.id}`);
  expect(listFrom.json.items.length).toBe(0);
  const listTo = await jsonReq(handle, 'GET', `/api/fs/list?id=${to.json.node.id}`);
  expect(listTo.json.items.map((n) => n.name)).toEqual(['renamed.txt']);
});
