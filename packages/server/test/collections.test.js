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

test('default collection is open in zero-config', async () => {
  const { handle } = await createServer();
  const cols = await api(handle, 'GET', '/api/collections');
  expect(cols.json.collections[0].id).toBe('default');
  // anonymous can create a folder in the default (open) collection
  const f = await api(handle, 'POST', '/api/fs/folder', { body: { parentId: 'root', name: 'x' } });
  expect(f.status).toBe(200);
});

async function adminServer() {
  return createServer({
    identity: { driver: 'jwt', jwt: { secret: SECRET, now: NOW, algorithms: ['HS256'] } },
    admins: ['boss'],
    startFlusher: false,
  });
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

  // Write a file into the new collection (its own memory store).
  const root = await api(handle, 'GET', `/api/fs/list?collection=${cid}&path=/`, { token: boss });
  expect(root.status).toBe(200);
  const rootId = root.json.node.id;
  expect(rootId).not.toBe('root'); // a distinct collection root

  const folder = await api(handle, 'POST', '/api/fs/folder', { token: boss, body: { parentId: rootId, name: 'secret' } });
  expect(folder.status).toBe(200);
  expect(folder.json.node.collectionId).toBe(cid);

  // The default collection does NOT see it.
  const defaultList = await api(handle, 'GET', '/api/fs/list?path=/', { token: boss });
  expect(defaultList.json.items.some((i) => i.name === 'secret')).toBe(false);

  // A reader with no grant can't even read the new collection.
  const noAccess = await api(handle, 'GET', `/api/fs/list?collection=${cid}&path=/`, { token: reader });
  expect(noAccess.status).toBe(403);

  // Grant the reader read-only, then they can list but not write or delete.
  await api(handle, 'POST', `/api/collections/${cid}/grants`, { token: boss, body: { type: 'user', subject: 'reader', capabilities: ['read'] } });
  const canRead = await api(handle, 'GET', `/api/fs/list?collection=${cid}&path=/`, { token: reader });
  expect(canRead.status).toBe(200);
  const cantWrite = await api(handle, 'POST', '/api/fs/folder', { token: reader, body: { parentId: rootId, name: 'nope' } });
  expect(cantWrite.status).toBe(403);
  const cantDelete = await api(handle, 'POST', '/api/fs/delete', { token: reader, body: { id: folder.json.node.id } });
  expect(cantDelete.status).toBe(403);
});
