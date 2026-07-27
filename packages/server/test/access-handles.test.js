// Authorization you hold, not authorization you remembered to check.
//
// The old shape: stat the node, find its collection, assert a capability, then
// operate through an unrestricted vfs with a raw id. Twenty-six sites, four
// steps each, in order. The check and the use were separate — so a caller who
// asserted `read` still held a vfs and an id, and `vfs.remove(id)` was one line
// away.
//
// These check the two properties that make the handle worth having: the grant
// determines what exists, and denial happens during the LEASE, so an action that
// may not act never runs at all.

import { test, expect } from 'bun:test';
import { Action, Query } from '@3sln/ngin';
import { createServer, configFromEnv } from '../src/index.js';
import { createDriveEngine } from '../src/engine/index.js';

const ENV = { TROVE_STORAGE: 'memory' };

async function drive(extra = {}) {
  const server = await createServer({ ...configFromEnv(ENV), ...extra });
  const item = await server.vfs.writeFile('notes.md', 'hello', { contentType: 'text/markdown' });
  return { server, item, container: server.engineContainer };
}

const lease = (server, deps) => server.engineContainer.use(deps, (r) => r);

const methodsOf = (handle) =>
  Object.keys(handle).filter((k) => typeof handle[k] === 'function').sort();

// --- the whole surface, written down ----------------------------------------
//
// A method under the wrong capability is silent: the handle simply lacks it, and
// nothing says so until a route calls it. That is how `listTrash` shipped under
// `read` while every trash route asks for `delete` — GET /api/trash threw
// "listTrash is not a function" in a browser, not in a test.
//
// So the surface is pinned. Adding a method means adding it here, which means
// deciding which grant it belongs to instead of defaulting into one.

const NODE_SURFACE = {
  // `mintUrl` is under `read` because minting a URL that carries its own grant is
  // DELEGATING the read you hold — to an <img src> or a <video src>, which cannot
  // present credentials. Anywhere else and a caller without read could hand one out.
  read: ['backlinks', 'download', 'mintUrl', 'read', 'subscribe', 'unsubscribe', 'view'],
  write: ['comment', 'contribute', 'deleteComment', 'editComment', 'react', 'removeTag', 'rename', 'setTag'],
  delete: ['remove', 'restore'],
};
const COLLECTION_SURFACE = {
  read: ['list', 'storage', 'usage'],
  write: ['createUpload', 'writeFile'],
  delete: ['listTrash', 'purgeTrash'],
};

for (const [capability, expected] of Object.entries(NODE_SURFACE)) {
  test(`a node handle for "${capability}" has exactly its own methods`, async () => {
    const { server, item } = await drive();
    const { node } = await lease(server, { node: { id: item.id, capability } });
    expect(methodsOf(node)).toEqual([...expected].sort());
    await server.close();
  });
}

for (const [capability, expected] of Object.entries(COLLECTION_SURFACE)) {
  test(`a collection handle for "${capability}" has exactly its own methods`, async () => {
    const { server } = await drive();
    const { collection } = await lease(server, { collection: { id: 'default', capability } });
    expect(methodsOf(collection)).toEqual([...expected].sort());
    await server.close();
  });
}

test('admin is the union, and the system grant matches it', async () => {
  const { server, item } = await drive();
  const all = Object.values(NODE_SURFACE).flat().sort();
  const { node } = await lease(server, { node: { id: item.id, capability: 'admin' } });
  expect(methodsOf(node)).toEqual(all);
  const { systemNode } = await lease(server, { systemNode: { id: item.id } });
  expect(methodsOf(systemNode)).toEqual(all);
  await server.close();
});

// --- the grant determines what exists ---------------------------------------

test('a read handle has no way to destroy anything', async () => {
  const { server, item } = await drive();
  const { node } = await lease(server, { node: { id: item.id, capability: 'read' } });

  expect(typeof node.read).toBe('function');
  // Not "throws when called" — absent. There is no remove to reach for.
  expect(node.remove).toBeUndefined();
  expect(node.rename).toBeUndefined();
  expect(node.setTag).toBeUndefined();
  await server.close();
});

test('a write handle can rename but not delete', async () => {
  const { server, item } = await drive();
  const { node } = await lease(server, { node: { id: item.id, capability: 'write' } });
  expect(typeof node.rename).toBe('function');
  expect(node.remove).toBeUndefined();
  expect((await node.rename('renamed.md')).name).toBe('renamed.md');
  await server.close();
});

test('a delete handle can remove, and nothing else', async () => {
  // `read` is NOT implied. CollectionService implies nothing but admin, and a
  // handle that decided otherwise would be a second, more permissive model of
  // the same rule.
  const { server, item } = await drive();
  const { node } = await lease(server, { node: { id: item.id, capability: 'delete' } });
  expect(typeof node.remove).toBe('function');
  expect(node.read).toBeUndefined();
  expect(node.rename).toBeUndefined();
  await node.remove();
  await server.close();
});

test('an admin handle is wide, because admin does imply the rest', async () => {
  const { server, item } = await drive();
  const { node } = await lease(server, { node: { id: item.id, capability: 'admin' } });
  expect(typeof node.read).toBe('function');
  expect(typeof node.rename).toBe('function');
  expect(typeof node.remove).toBe('function');
  await server.close();
});

test('asking narrowly stays narrow, even for someone who holds everything', async () => {
  // Least privilege. On a default open drive the caller holds every capability;
  // a handle asked for `read` still cannot delete, because holding a capability
  // and wielding it are different things.
  const { server, item } = await drive();
  const { node } = await lease(server, { node: { id: item.id, capability: 'read' } });
  expect(typeof node.read).toBe('function');
  expect(node.remove).toBeUndefined();
  await server.close();
});

test('the handle carries data, not a key to use elsewhere', async () => {
  // `id` is on the handle so a response can name what it acted on. What is NOT
  // there is a vfs — the handle is the only way to operate, which is the whole
  // point: the grant travels with the object rather than being checked once and
  // thrown away.
  const { server, item } = await drive();
  const { node } = await lease(server, { node: { id: item.id, capability: 'read' } });
  expect(node.id).toBe(item.id);
  expect(node.collectionId).toBe('default');
  expect(node.vfs).toBeUndefined();
  await server.close();
});

// --- denial happens during the lease ----------------------------------------

test('an action that may not act never runs', async () => {
  // The property an interceptor could not have given us, because ngin runs
  // interceptors on the dispatcher only — a query would have escaped one.
  const { server, item } = await drive({ defaultOpen: false, admins: ['someone@else'] });
  let ran = false;

  class DeleteItem extends Action {
    static deps = [];
    constructor(id) { super(); this.deps = { node: { principal: { id: 'nobody' }, id, capability: 'delete' } }; }
    async execute({ node }) { ran = true; await node.remove(); }
  }

  const feed = server.engine.dispatch(new DeleteItem(item.id));
  await expect(feed.next(['result'])).rejects.toThrow(/lack "delete"|forbidden|permission/i);
  expect(ran).toBe(false);
  await server.close();
});

test('a query is gated the same way, from the same declaration', async () => {
  const { server, item } = await drive({ defaultOpen: false, admins: ['someone@else'] });
  class ReadItem extends Query {
    static deps = [];
    constructor(id) { super(); this.deps = { node: { principal: { id: 'nobody' }, id, capability: 'read' } }; }
    async fetch({ node }) { return node.name; }
  }
  await expect(server.engine.queries.query(new ReadItem(item.id)).peek())
    .rejects.toThrow(/lack "read"|forbidden|permission/i);
  await server.close();
});

test('a capability that is not one is refused, not silently treated as none', async () => {
  const { server, item } = await drive();
  await expect(lease(server, { node: { id: item.id, capability: 'writeee' } }))
    .rejects.toThrow(/Unknown capability/);
  await server.close();
});

// --- the background domain --------------------------------------------------

test('the system grant is a separate provider, not an option anyone can pass', async () => {
  // An option is a value, and values travel — copied from another action, read
  // from a variable, arriving from somewhere they should not. A grant that
  // cannot be obtained by passing a principal cannot be reached by passing the
  // wrong one. So `node` has no escape hatch...
  const { server, item } = await drive({ defaultOpen: false, admins: ['someone@else'] });
  await expect(lease(server, { node: { principal: { id: 'nobody' }, id: item.id, capability: 'delete', system: true } }))
    .rejects.toThrow(/lack "delete"|forbidden|permission/i);

  // ...and asking for the system grant means naming a different provider, which
  // shows up in the dependency list a reader is already looking at.
  const { systemNode } = await lease(server, { systemNode: { id: item.id } });
  expect(systemNode.granted).toBe('system');
  expect(typeof systemNode.remove).toBe('function');
  await server.close();
});

test('turning collections off grants everything, by configuration', async () => {
  const { server, item } = await drive({ collections: false });
  const { node } = await lease(server, { node: { id: item.id, capability: 'delete' } });
  expect(typeof node.remove).toBe('function');
  await server.close();
});

test('the handle reflects what the principal HOLDS, not what it asserted', async () => {
  // The bug this replaced: implication was decided here — write implies read,
  // delete implies read — and CollectionService does not agree. Only `admin`
  // implies anything there, so a grant of ['write'] alone carries no read. A
  // handle obtained with capability 'write' was therefore handing out read,
  // download and view to a principal the ACL had never given them to. Two models
  // of one rule, with the more permissive winning.
  const server = await createServer({ ...configFromEnv(ENV), defaultOpen: false, admins: ['root'] });
  const item = await server.vfs.writeFile('w.md', 'x', { contentType: 'text/markdown' });
  const writer = { id: 'writer@example.com' };
  await server.collections.update('default',
    { acl: { grants: [{ type: 'user', subject: writer.id, capabilities: ['write'] }] } },
    { id: 'root' });

  const { node } = await server.engineContainer.use(
    { node: { principal: writer, id: item.id, capability: 'write' } }, (r) => r,
  );
  expect(typeof node.rename).toBe('function');   // asked for write, and holds it
  expect(node.read).toBeUndefined();             // does NOT hold read
  expect(node.download).toBeUndefined();
  await server.close();
});

test('a missing collections service refuses rather than allows', async () => {
  // The failure that started all of this, in its new home: enforcement decides
  // from config, so a service that cannot answer throws instead of standing down.
  const engine = createDriveEngine(configFromEnv(ENV));
  const collections = engine.container.get('collections');
  collections.obtain = async () => { throw new Error('service unavailable'); };
  const server = await createServer(configFromEnv(ENV));
  const item = await server.vfs.writeFile('x.md', 'x', { contentType: 'text/markdown' });

  await expect(engine.container.use({ node: { id: item.id, capability: 'delete' } }, () => {}))
    .rejects.toThrow();
  await engine.dispose();
  await server.close();
});
