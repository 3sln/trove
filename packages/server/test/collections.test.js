// Collections: creation gated by capability, per-collection backing stores &
// isolation, and read/write/delete permission enforcement over the HTTP layer.

import { test, expect } from 'bun:test';
import { createServer } from '../src/index.js';

const enc = new TextEncoder();
const b64url = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const NOW = 1_700_000_000_000;
const SECRET = 's';
async function mint(payload) {
  const h = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64url(enc.encode(JSON.stringify({ exp: NOW / 1000 + 3600, ...payload })));
  const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}
async function api(handle, method, path, { token, body } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handle(new Request(`http://t${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

// Put an item into a collection THROUGH THE API, so the capability checks that gate a
// real write are the ones exercised. Returns the created node (or the failing status).
async function writeInto(handle, collection, token, name, content = 'x') {
  const start = await api(handle, 'POST', `/api/collections/${collection}/uploads`, {
    token, body: { name, size: content.length, contentType: 'text/plain' },
  });
  if (start.status !== 200) return { status: start.status };
  await handle(new Request(`http://t${start.json.transfer.partUrl.replace('{partNumber}', '1')}`, {
    method: 'PUT', headers: token ? { authorization: `Bearer ${token}` } : {}, body: content,
  }));
  const done = await api(handle, 'POST', start.json.endpoints.complete, { token, body: {} });
  return { status: done.status, ...(done.json?.node || {}) };
}

test('default collection is open in zero-config', async () => {
  const { handle, collections: __cols } = await createServer();
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const cols = await api(handle, 'GET', '/api/collections');
  expect(cols.json.collections[0].id).toBe('default');
  // anonymous can list (and write to) the default (open) collection
  const f = await api(handle, 'GET', '/api/collections/default/items');
  expect(f.status).toBe(200);
});

async function adminServer() {
  const server = await createServer({
    identity: { driver: 'jwt', jwt: { secret: SECRET, now: NOW, algorithms: ['HS256'] } },
    admins: ['boss'],
    startFlusher: false,
  });
  // Nothing is seeded any more, and this suite is about isolation BETWEEN collections —
  // so it needs the one it compares against to exist.
  await server.collections?.ensure({ id: 'default', name: 'My Drive' });
  return server;
}

test('collection creation is gated by the create capability', async () => {
  const { handle } = await adminServer();
  const boss = await mint({ sub: 'boss', name: 'Boss' });
  const worker = await mint({ sub: 'worker', name: 'Worker' });

  // Non-admin cannot create.
  const denied = await api(handle, 'POST', '/api/collections', { token: worker, body: { name: 'Team', store: { driver: 'memory' } } });
  expect(denied.status).toBe(403);

  // Admin can, and is granted admin on it.
  const created = await api(handle, 'POST', '/api/collections', { token: boss, body: { name: 'Team', store: { driver: 'memory' } } });
  expect(created.status).toBe(200);
  const cid = created.json.collection.id;
  expect(created.json.collection.capabilities).toContain('admin');
  return { handle, boss, worker, cid };
});

test('collections isolate data and enforce read/write/delete', async () => {
  const { handle } = await adminServer();
  const boss = await mint({ sub: 'boss' });
  const reader = await mint({ sub: 'reader' });

  const created = await api(handle, 'POST', '/api/collections', { token: boss, body: { name: 'Vault', store: { driver: 'memory' } } });
  const cid = created.json.collection.id;

  // The new collection is its own namespace, initially empty.
  const listed = await api(handle, 'GET', `/api/collections/${cid}/items`, { token: boss });
  expect(listed.status).toBe(200);
  expect(listed.json.items).toEqual([]);
  expect(listed.json.collectionId).toBe(cid);

  const secret = await writeInto(handle, cid, boss, 'secret.txt');
  expect(secret.status).toBe(200);
  expect(secret.collectionId).toBe(cid);

  // The default collection does NOT see it — collections are separate namespaces, so
  // the same name can exist in both without colliding.
  const defaultList = await api(handle, 'GET', '/api/collections/default/items', { token: boss });
  expect(defaultList.json.items.some((i) => i.name === 'secret.txt')).toBe(false);
  expect((await writeInto(handle, 'default', boss, 'secret.txt')).status).toBe(200);

  // A reader with no grant can't even read the new collection.
  const noAccess = await api(handle, 'GET', `/api/collections/${cid}/items`, { token: reader });
  expect(noAccess.status).toBe(403);

  // Grant the reader read-only, then they can list but not write or delete.
  await api(handle, 'POST', `/api/collections/${cid}/grants`, { token: boss, body: { type: 'user', subject: 'reader', capabilities: ['read'] } });
  const canRead = await api(handle, 'GET', `/api/collections/${cid}/items`, { token: reader });
  expect(canRead.status).toBe(200);
  expect(canRead.json.items.map((i) => i.name)).toEqual(['secret.txt']);
  expect((await writeInto(handle, cid, reader, 'nope.txt')).status).toBe(403);
  const cantDelete = await api(handle, 'POST', '/api/items/delete', { token: reader, body: { id: secret.id } });
  expect(cantDelete.status).toBe(403);
});

test('upload lifecycle routes re-check write on the session collection', async () => {
  const { handle } = await adminServer();
  const boss = await mint({ sub: 'boss' });
  const reader = await mint({ sub: 'reader' });
  const created = await api(handle, 'POST', '/api/collections', { token: boss, body: { name: 'Vault', store: { driver: 'memory' } } });
  const cid = created.json.collection.id;
  await api(handle, 'POST', `/api/collections/${cid}/grants`, { token: boss, body: { type: 'user', subject: 'reader', capabilities: ['read'] } });

  // Boss starts an upload into the vault.
  const start = await api(handle, 'POST', `/api/collections/${cid}/uploads`, { token: boss, body: { name: 'f.bin', size: 4, contentType: 'application/octet-stream' } });
  const uploadId = start.json.uploadId;

  // A read-only principal can't inspect, drive, complete, or abort someone's upload.
  expect((await api(handle, 'GET', `/api/uploads/${uploadId}/status`, { token: reader })).status).toBe(403);
  expect((await api(handle, 'POST', `/api/uploads/${uploadId}/complete`, { token: reader, body: {} })).status).toBe(403);
  expect((await api(handle, 'DELETE', `/api/uploads/${uploadId}`, { token: reader })).status).toBe(403);
  // The owner still can.
  expect((await api(handle, 'GET', `/api/uploads/${uploadId}/status`, { token: boss })).status).toBe(200);
});

test('a read-only user cannot add OR remove tags (tag DELETE is write-gated)', async () => {
  const { handle } = await adminServer();
  const boss = await mint({ sub: 'boss' });
  const reader = await mint({ sub: 'reader' });
  const created = await api(handle, 'POST', '/api/collections', { token: boss, body: { name: 'Vault', store: { driver: 'memory' } } });
  const cid = created.json.collection.id;
  const file = await writeInto(handle, cid, boss, 'doc.txt');
  const id = file.id;
  // Boss tags it.
  const tagged = await api(handle, 'POST', `/api/items/${id}/tags`, { token: boss, body: { name: 'fav', value: 'yes' } });
  expect(tagged.status).toBe(200);

  await api(handle, 'POST', `/api/collections/${cid}/grants`, { token: boss, body: { type: 'user', subject: 'reader', capabilities: ['read'] } });
  // Read-only reader can neither add nor remove tags.
  const cantAdd = await api(handle, 'POST', `/api/items/${id}/tags`, { token: reader, body: { name: 'x', value: '1' } });
  expect(cantAdd.status).toBe(403);
  const cantRemove = await api(handle, 'DELETE', `/api/items/${id}/tags/fav`, { token: reader });
  expect(cantRemove.status).toBe(403);
  // And the tag survived the denied removal.
  const boss2 = await api(handle, 'GET', `/api/collections/default/items/resolve?id=${id}`, { token: boss });
  expect(boss2.json.node.tags?.fav).toBe('yes');
});

test('capabilities reports the STORE of the collection asked about', async () => {
  // The client picks its upload strategy from this. Reporting the default
  // collection's backend for a request about another one hands it the wrong plan —
  // and reading a collection's configuration needs `read` on that collection.
  const { handle } = await adminServer();
  const boss = await mint({ sub: 'boss' });
  const outsider = await mint({ sub: 'outsider' });
  const created = await api(handle, 'POST', '/api/collections', {
    token: boss, body: { name: 'Vault', store: { driver: 'memory' } },
  });
  const cid = created.json.collection.id;

  const own = await api(handle, 'GET', `/api/capabilities?collection=${cid}`, { token: boss });
  expect(own.status).toBe(200);
  expect(own.json.collection).toBe(cid);
  expect(own.json.storage.multipart).toBe(true);

  expect((await api(handle, 'GET', `/api/capabilities?collection=${cid}`, { token: outsider })).status).toBe(403);
});
