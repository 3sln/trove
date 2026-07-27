// The drive as a dependency graph.
//
// The graph exists to make three things derived that used to be maintained by
// hand in `createServer`: build order, teardown order, and when things get
// built at all. These check that they really are derived — a graph nobody
// verifies is just a different place to keep the same list.

import { test, expect } from 'bun:test';
import { Provider, Container } from '@3sln/ngin';
import { createServer, configFromEnv } from '../src/index.js';
import { createDriveEngine, driveProviders, BACKBONE } from '../src/engine/index.js';

const ENV = { TROVE_STORAGE: 'memory' };

test('every name the server hands back is a provider in the graph', () => {
  // Otherwise `createServer` would be building something on the side, which is
  // the state this replaced.
  const names = Object.keys(driveProviders(configFromEnv(ENV), { closing: false }));
  for (const name of BACKBONE) expect(names).toContain(name);
});

test('nothing is built until something needs it', async () => {
  // `await sqlite.init()`, `await vfs.init()` and `await plugins.init()` used to
  // run at construction whether or not anything used them.
  const engine = createDriveEngine(configFromEnv(ENV));
  const built = [];
  for (const name of ['storage', 'sqlite', 'vfs']) {
    const provider = engine.container.get(name);
    const real = provider.obtain.bind(provider);
    provider.obtain = (...args) => { built.push(name); return real(...args); };
  }
  expect(built).toEqual([]);

  await engine.container.use(['storage'], () => {});
  expect(built).toEqual(['storage']);
  await engine.dispose();
});

test('a resource is built once however many things ask for it', async () => {
  // sqlite is named by metadata, kv, search and plugins. Four databases where
  // one was meant would be a data bug, not a performance one.
  const engine = createDriveEngine(configFromEnv(ENV));
  const [a, b] = await Promise.all([
    engine.container.use(['sqlite'], (r) => r.sqlite),
    engine.container.use(['metadata', 'kv'], async () => engine.container.use(['sqlite'], (r) => r.sqlite)),
  ]);
  expect(a).toBe(b);
  await engine.dispose();
});

test('teardown order comes from the declarations, not the source order', async () => {
  // Worth being precise about: the providers happen to be WRITTEN in dependency
  // order, so a reverse-of-source teardown would pass the assertions below too.
  // What is actually being relied on is that each one declares its needs — check
  // that first, or this test proves nothing it claims to.
  const engine = createDriveEngine(configFromEnv(ENV));
  const declared = (name) => engine.container.get(name).constructor.deps;
  expect(declared('metadata')).toEqual(['sqlite']);
  expect(declared('kv')).toEqual(['sqlite', 'metadata']);
  expect(declared('sidecar')).toEqual(['storage', 'issues', 'notifications']);
  expect(declared('vfs')).toContain('sidecar');

  const order = [];
  for (const name of ['sqlite', 'kv', 'issues', 'sidecar', 'notifications', 'vfs']) {
    const provider = engine.container.get(name);
    const real = provider.dispose?.bind(provider);
    provider.dispose = async () => { order.push(name); await real?.(); };
  }
  await engine.container.use(['vfs', 'notifications'], () => {});
  await engine.dispose();

  const at = (name) => order.indexOf(name);
  expect(at('vfs')).toBeLessThan(at('sidecar'));
  expect(at('sidecar')).toBeLessThan(at('issues'));
  expect(at('issues')).toBeLessThan(at('kv'));
  expect(at('kv')).toBeLessThan(at('sqlite'));
  expect(at('notifications')).toBeLessThan(at('kv'));
});

test('a cycle is refused by name rather than producing undefined', () => {
  // Not reachable through the drive's own graph, which is acyclic — recorded
  // here because it is the guarantee that makes a declared graph safer than a
  // hand-ordered one, where a cycle shows up as a mystery `undefined`.
  expect(() => new Container({
    providers: {
      a: class extends Provider { static deps = ['b']; },
      b: class extends Provider { static deps = ['a']; },
    },
  })).toThrow(/Cyclic dependency/);
});

test('an injected instance is still exactly what comes out', async () => {
  // The property every existing test rests on: `createServer({ storage })` means
  // what it always did, container or not.
  const { MemoryStorage, TaskRegistry } = await import('@trove/core');
  const storage = new MemoryStorage();
  const tasks = new TaskRegistry();
  const server = await createServer({ ...configFromEnv(ENV), storage, tasks });
  expect(server.tasks).toBe(tasks);
  expect(await server.vfs.storageFor('default')).toBe(storage);
  await server.close();
});

test('closing the server disposes the graph', async () => {
  const server = await createServer(configFromEnv(ENV));
  await server.close();
  // The container refuses further leases once disposed, which is how a use
  // after close fails loudly instead of touching a closed database.
  await expect(server.startScan('default', { reason: 'after close' })).rejects.toThrow(/disposed/i);
});

test('shutdown is a dependency, not a captured variable', async () => {
  // Long work has to be able to ask whether the server is going down. That used
  // to be a `let closing` nothing could see it reading.
  const engine = createDriveEngine(configFromEnv(ENV), { closing: false });
  const seen = await engine.container.use(['lifecycle'], (r) => r.lifecycle.closing);
  expect(seen).toBe(false);
  await engine.dispose();
});
