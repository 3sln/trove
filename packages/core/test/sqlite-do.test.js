// A Durable Object per plugin scope.
//
// `D1SqliteProvider` cannot do this and says so itself: a scope key embeds the runtime
// principal — `pstore:alice@x.com:plg:acme/notes` — so it can never be pre-bound, and D1
// cannot create a database on demand. What shipped was one nominated binding holding every
// plugin's tables for every user side by side. The keys stayed distinct; the boundary was
// a naming convention.
//
// A DO is addressable BY NAME, which is the missing primitive.

import { test, expect } from 'bun:test';
import { DurableObjectSqliteProvider, isPluginScope } from '../src/sqlite-do.js';

/** A namespace that records what was addressed, and answers SQL from a per-name log. */
function fakeNamespace() {
  const objects = new Map();
  return {
    named: [],
    idFromName(name) { this.named.push(name); return { name }; },
    get(id) {
      if (!objects.has(id.name)) objects.set(id.name, { name: id.name, calls: [] });
      const obj = objects.get(id.name);
      return {
        name: id.name,
        fetch: async (url, init) => {
          const body = init?.body ? JSON.parse(init.body) : null;
          obj.calls.push({ url, body });
          return new Response(JSON.stringify({ result: { store: id.name, op: body?.op } }), {
            headers: { 'content-type': 'application/json' },
          });
        },
      };
    },
    objects,
  };
}

test('a scope is its own object, named by the scope key', async () => {
  // THE POINT. Two scopes are two objects with two databases, not two prefixes in one.
  const ns = fakeNamespace();
  const p = new DurableObjectSqliteProvider({ namespace: ns });
  await (await p.obtain({ key: 'pstore:alice:plg:acme/notes' })).all('SELECT 1');
  await (await p.obtain({ key: 'pstore:bob:plg:acme/notes' })).all('SELECT 1');

  expect(ns.named).toEqual(['pstore:alice:plg:acme/notes', 'pstore:bob:plg:acme/notes']);
  expect(ns.objects.size).toBe(2);
});

test('the same scope is the same object, and the handle is memoized', async () => {
  const ns = fakeNamespace();
  const p = new DurableObjectSqliteProvider({ namespace: ns });
  const a = await p.obtain({ key: 'pstore:alice:plg:acme/notes' });
  const b = await p.obtain({ key: 'pstore:alice:plg:acme/notes' });
  expect(a).toBe(b);
  expect(ns.named.length).toBe(1);
});

test('core stores are left where they are', async () => {
  // Routing metadata through a DO would put the whole drive behind one single-threaded
  // object. They are one-per-deployment and can simply be bound, so they stay on D1.
  const ns = fakeNamespace();
  const core = { obtain: async ({ key }) => ({ core: key }), drop: async () => {} };
  const p = new DurableObjectSqliteProvider({ namespace: ns, core });
  expect(await p.obtain({ key: 'metadata' })).toEqual({ core: 'metadata' });
  expect(await p.obtain({ key: 'search' })).toEqual({ core: 'search' });
  expect(ns.named).toEqual([]);   // no object was addressed at all
});

test('plugin scopes are told apart from core keys', () => {
  expect(isPluginScope('pstore:alice:plg:acme/notes')).toBe(true);
  expect(isPluginScope('metadata')).toBe(false);
  expect(isPluginScope('kv')).toBe(false);
  expect(isPluginScope(null)).toBe(false);
});

test('it claims durability, because a DO outlives the isolate', async () => {
  // The server asks before putting the search index in SQLite: an index in an ephemeral
  // database is worse than one in memory, because it looks persistent until the restart.
  expect(new DurableObjectSqliteProvider({ namespace: fakeNamespace() }).durable).toBe(true);
});

test('dropping a scope asks the object to empty itself', async () => {
  // Its storage outlives this process, so forgetting the handle would leave the data
  // behind — which for an uninstalled plugin is the difference between removed and
  // merely unaddressed.
  const ns = fakeNamespace();
  const p = new DurableObjectSqliteProvider({ namespace: ns });
  await p.obtain({ key: 'pstore:alice:plg:acme/notes' });
  await p.drop({ key: 'pstore:alice:plg:acme/notes' });
  const obj = ns.objects.get('pstore:alice:plg:acme/notes');
  expect(obj.calls.some((c) => String(c.url).endsWith('/drop'))).toBe(true);
});

test('a namespace is required, so it cannot exist unable to work', () => {
  expect(() => new DurableObjectSqliteProvider({})).toThrow();
  expect(() => new DurableObjectSqliteProvider({ namespace: {} })).toThrow();
});
