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

test('a delete handle can remove, and reading is implied throughout', async () => {
  const { server, item } = await drive();
  const { node } = await lease(server, { node: { id: item.id, capability: 'delete' } });
  expect(typeof node.remove).toBe('function');
  expect(typeof node.read).toBe('function'); // you cannot delete what you may not see
  await node.remove();
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
  expect(node.granted).toBe('admin');
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
