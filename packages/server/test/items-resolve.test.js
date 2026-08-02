// Resolving an item by id, with no collection in the path.
//
// This route's absence was a real outage with a confusing face. `api.stat(ref)` builds
// `/api/items/resolve` whenever it is not handed a collection — the normal case, since an
// id names itself — and the server had only the scoped form. So every call answered
// "No such route", which broke `ctx.files.blob()` for every plugin, and with it any viewer
// that reads its own file. The audiobook player showed it as no cover art and no ability
// to stream; opening it on the drive just said "No such route" and stopped.

import { test, expect } from 'bun:test';
import { createServer } from '../src/index.js';

async function json(handle, method, path, body) {
  const res = await handle(new Request(`http://t${path}`, {
    method, headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function makeServer() {
  const s = await createServer({ admins: ['anonymous'] });
  await s.collections?.ensure({ id: 'default', name: 'My Drive' });
  return s;
}

async function upload(handle, name, content) {
  const create = await json(handle, 'POST', '/api/collections/default/uploads', { parentId: 'root', name, size: content.length, contentType: 'application/octet-stream' });
  const d = create.json;
  await handle(new Request(`http://t${d.transfer.partUrl.replace('{partNumber}', '1')}`, { method: 'PUT', body: content }));
  const done = await json(handle, 'POST', d.endpoints.complete, {});
  return done.json.node;
}

test('an item resolves by id without naming its collection', async () => {
  const { handle } = await makeServer();
  const node = await upload(handle, 'notes.md', 'hello');

  const flat = await json(handle, 'GET', `/api/items/resolve?id=${node.id}`);
  expect(flat.status).toBe(200);
  expect(flat.json.node.id).toBe(node.id);
  expect(flat.json.node.name).toBe('notes.md');
  // The size is the field `files.blob()` needs before `slice()` means anything — a stat
  // that answers without it produces a zero-length blob and reads that return nothing.
  expect(flat.json.node.size).toBe(5);

  // The scoped form still answers the same thing, so nothing that already worked moved.
  const scoped = await json(handle, 'GET', `/api/collections/default/items/resolve?id=${node.id}`);
  expect(scoped.json.node.id).toBe(node.id);
});

test('a name is refused rather than guessed at', async () => {
  const { handle } = await makeServer();
  await upload(handle, 'notes.md', 'hello');
  // A name is only unique inside a collection, so resolving one here has more than one
  // right answer. Saying so beats picking.
  const r = await json(handle, 'GET', '/api/items/resolve?name=notes.md');
  expect(r.status).toBe(400);
  expect(JSON.stringify(r.json)).toMatch(/only unique within a collection/);
});

test('a missing ref and an unknown id are told apart', async () => {
  const { handle } = await makeServer();
  expect((await json(handle, 'GET', '/api/items/resolve')).status).toBe(400);
  expect((await json(handle, 'GET', '/api/items/resolve?id=itm_nope')).status).toBe(404);
});
