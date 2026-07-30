// Drives the server through Web Requests end-to-end: capabilities, folder
// creation, a full direct multipart upload, download with a Range request, and
// search — all in-memory, no network.

import { test, expect } from 'bun:test';
import { zipSync, strToU8 } from 'fflate';
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
  const { handle, collections: __cols } = await createServer();
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const h = await jsonReq(handle, 'GET', '/api/health');
  expect(h.json.ok).toBe(true);
  const caps = await jsonReq(handle, 'GET', '/api/capabilities');
  expect(caps.json.storage.multipart).toBe(true);
  expect(caps.json.features.semanticSearch).toBe(true);
});

test('upload + download + range + search', async () => {
  const { handle, collections: __cols } = await createServer();
  await __cols?.ensure({ id: 'default', name: 'My Drive' });

  const content = 'Dune is a science fiction novel about desert planet Arrakis and spice.';
  const size = new TextEncoder().encode(content).length;
  const plan = await jsonReq(handle, 'POST', '/api/collections/default/uploads', {
    name: 'dune.txt', size, contentType: 'text/plain',
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
  const dl = await handle(new Request(`http://t/api/items/download?id=${fileId}`));
  expect(dl.status).toBe(200);
  expect(await dl.text()).toBe(content);

  // Range download → 206.
  const ranged = await handle(new Request(`http://t/api/items/download?id=${fileId}`, {
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
  // An indexer runs server-side, so installing one is admin-gated.
  const { handle, vfs, collections: __cols } = await createServer({ admins: ['anonymous'] });
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const file = await vfs.writeFile('photo.jpg', new Uint8Array([1, 2, 3]), { contentType: 'image/jpeg' });
  // Contributing under a plugin's namespace is a claim to BE that plugin, so it has to
  // actually be installed — otherwise the namespace is only as unforgeable as a string.
  await handle(new Request('http://t/api/plugins/install?grants=indexer', {
    method: 'POST',
    body: zipSync({
      'manifest.json': strToU8(JSON.stringify({
        domain: 'vision.example', name: 'labeller', version: '1.0.0',
        capabilities: { indexer: true },
        entry: 'plugin.js',
        contributes: { idx: { type: 'indexer', match: { mime: ['image/*'] } } },
      })),
      'plugin.js': strToU8('//'),
    }),
  }));
  // The namespace is the plugin's contribution URI — see plugin-install.test.js for
  // why a bare name is refused.
  const ns = encodeURIComponent('trove+contrib:vision.example/labeller/idx');
  const idx = await jsonReq(handle, 'POST', `/api/index/${ns}`, {
    nodeId: file.id,
    documents: [{ text: 'a golden retriever puppy playing on green grass in a park' }],
    facet: { labels: ['dog', 'grass', 'park'] },
  });
  expect(idx.json.ok).toBe(true);
  const search = await jsonReq(handle, 'GET', '/api/search?q=puppy%20park');
  expect(search.json.results.some((r) => r.node.name === 'photo.jpg')).toBe(true);
});

test('plugin storage SQL: scoped round-trip + ATTACH rejected', async () => {
  const { handle, collections: __cols } = await createServer();
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
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
  const { handle, vfs, collections: __cols } = await createServer();
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const file = await vfs.writeFile('x.txt', 'hi', { contentType: 'text/plain' });
  await jsonReq(handle, 'POST', `/api/items/${file.id}/tags`, { name: 'fav', value: 'yes' });
  const list = await jsonReq(handle, 'GET', '/api/collections/default/items');
  const row = list.json.items.find((n) => n.id === file.id);
  expect(row.tags.fav).toBe('yes'); // merged view
  expect(row.contributions.user.tags.fav).toBe('yes'); // namespaced under the 'user' scope

  await jsonReq(handle, 'DELETE', `/api/items/${file.id}/tags/fav`);
  const after = await jsonReq(handle, 'GET', '/api/collections/default/items');
  expect(after.json.items.find((n) => n.id === file.id).tags.fav).toBeFalsy(); // removed reads as absent
});

test('an item resolves by id, by name, and by its trove: URI', async () => {
  const { handle, vfs, collections: __cols } = await createServer();
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const node = await vfs.writeFile('notes.txt', 'hello', { contentType: 'text/plain' });

  const byId = await jsonReq(handle, 'GET', `/api/collections/default/items/resolve?id=${node.id}`);
  expect(byId.json.node.name).toBe('notes.txt');
  const byName = await jsonReq(handle, 'GET', '/api/collections/default/items/resolve?name=notes.txt');
  expect(byName.json.node.id).toBe(node.id);
  const byUri = await jsonReq(handle, 'GET', `/api/collections/default/items/resolve?uri=${encodeURIComponent('trove:default?name=notes.txt')}`);
  expect(byUri.json.node.id).toBe(node.id);
  // No selector at all is a bad request, not a silent listing.
  expect((await jsonReq(handle, 'GET', '/api/collections/default/items/resolve')).status).toBe(400);

  const renamed = await jsonReq(handle, 'POST', '/api/items/rename', { id: node.id, newName: 'renamed.txt' });
  expect(renamed.json.node.name).toBe('renamed.txt');
  // The old name is free, and no longer resolves.
  expect((await jsonReq(handle, 'GET', '/api/collections/default/items/resolve?name=notes.txt')).status).toBe(404);

  const listed = await jsonReq(handle, 'GET', '/api/collections/default/items');
  expect(listed.json.items.map((n) => n.name)).toEqual(['renamed.txt']);
  expect(listed.json.collectionId).toBe('default');
});

test('backlinks report what links to an item', async () => {
  const { handle, vfs, collections: __cols } = await createServer();
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const target = await vfs.writeFile('sailing.txt', 'Tacking upwind.', { contentType: 'text/plain' });
  await vfs.writeFile('trips.md', 'Trips\n\n- [Sailing](trove:default/sailing.txt)\n', { contentType: 'text/markdown' });
  await vfs.writeFile('unrelated.md', 'Nothing here.', { contentType: 'text/markdown' });

  const back = await jsonReq(handle, 'GET', `/api/items/backlinks?id=${target.id}`);
  expect(back.status).toBe(200);
  expect(back.json.items.map((n) => n.name)).toEqual(['trips.md']);
});
