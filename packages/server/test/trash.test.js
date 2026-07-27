// The trash, over HTTP, end to end.
//
// These exist because the routes did not. Every trash endpoint was rewritten onto
// access handles with no HTTP test to catch it, and one of them shipped broken:
// `listTrash` sat under `read` on the collection handle while `GET /api/trash` asks
// for `delete`, so the route threw "listTrash is not a function". A browser probe
// found it. A three-line request would have found it first.
//
// Trashed items are the awkward case in the whole design: `stat` deliberately cannot
// see them, so restore and permanent-delete are the two operations that must resolve
// something the ordinary path refuses to. That is a seam worth holding still.

import { test, expect } from 'bun:test';
import { createServer, configFromEnv } from '../src/index.js';

const ENV = { TROVE_STORAGE: 'memory' };
const post = (server, path, b) => server.handle(new Request(`http://t${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
}));

async function drive(extra = {}) {
  const server = await createServer({ ...configFromEnv(ENV), ...extra });
  const item = await server.vfs.writeFile('doomed.md', 'bye', { contentType: 'text/markdown' });
  return { server, item };
}

test('delete, list, restore — the round trip', async () => {
  const { server, item } = await drive();
  expect((await post(server, '/api/items/delete', { id: item.id })).status).toBe(200);

  const listed = await (await server.handle(new Request('http://t/api/trash'))).json();
  expect(listed.items.map((i) => i.id)).toContain(item.id);
  expect(listed.collectionId).toBe('default');

  // Restoring resolves an item `stat` cannot see. Before `statAny` the route reached
  // past the vfs into `metadata.getById`, which is a different resolver entirely.
  const restored = await (await post(server, '/api/trash/restore', { id: item.id })).json();
  expect(restored.node.id).toBe(item.id);
  expect(restored.node.deletedAt).toBeFalsy();

  // Back in the drive, and out of the trash.
  expect((await (await server.handle(new Request('http://t/api/trash'))).json()).items).toHaveLength(0);
  expect((await (await server.handle(new Request(`http://t/api/items/resolve?id=${item.id}`))).json()).node.id)
    .toBe(item.id);
  await server.close();
});

test('purging one item destroys it for good', async () => {
  const { server, item } = await drive();
  await post(server, '/api/items/delete', { id: item.id });
  expect(await (await post(server, '/api/trash/purge', { id: item.id })).json()).toEqual({ purged: 1 });
  expect((await post(server, '/api/trash/restore', { id: item.id })).status).toBe(404);
  await server.close();
});

test('purging a collection empties only that collection', async () => {
  // The bug the handle's first draft would have shipped: `vfs.purgeTrash` takes
  // `{ before, limit }` and no collection at all — it is the retention sweeper, and it
  // runs drive-wide. Passing it a `collectionId` it does not read looked scoped and
  // was not, so `delete` on one collection emptied every other collection's trash.
  const { server, item } = await drive({ admins: ['root'] });
  const other = await server.collections.create(
    {
      name: 'Other',
      store: { driver: 'memory' },
      acl: { grants: [{ type: 'anyone', capabilities: ['read', 'write', 'delete'] }] },
    },
    { id: 'root' },
  );
  const spared = await server.vfs.writeFile('keep.md', 'x', {
    contentType: 'text/markdown', collectionId: other.id,
  });
  await post(server, '/api/items/delete', { id: item.id });
  await post(server, '/api/items/delete', { id: spared.id });

  expect(await (await post(server, '/api/trash/purge', {})).json()).toEqual({ purged: 1 });

  const still = await (await server.handle(new Request(`http://t/api/trash?collection=${other.id}`))).json();
  expect(still.items.map((i) => i.id)).toEqual([spared.id]);
  await server.close();
});

test('the trash follows delete, not read', async () => {
  // Seeing what you deleted and undoing it are not lesser rights than deleting, and
  // its contents are items that have left the drive — a reader has no business
  // enumerating them. `read` alone is refused, on every trash endpoint.
  const server = await createServer({
    ...configFromEnv(ENV), defaultOpen: false, admins: ['root'],
  });
  const item = await server.vfs.writeFile('x.md', 'x', { contentType: 'text/markdown' });
  await server.collections.update('default',
    { acl: { grants: [{ type: 'anyone', capabilities: ['read', 'write'] }] } }, { id: 'root' });

  expect((await server.handle(new Request('http://t/api/trash'))).status).toBe(403);
  expect((await post(server, '/api/trash/purge', {})).status).toBe(403);
  expect((await post(server, '/api/trash/restore', { id: item.id })).status).toBe(403);
  await server.close();
});
