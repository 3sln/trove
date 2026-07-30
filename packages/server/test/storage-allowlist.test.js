// Narrowing the store types a deployment offers, from configuration alone.
//
// Adding a driver is a code decision — an entry point knows what its runtime can run.
// Removing one is an operator decision about a single deployment, so it has to be
// reachable without forking the entry point.
//
// The case that motivated it: `memory` is portable, so a Workers drive offers it, and
// choosing it there produces a collection that accepts uploads and loses them the moment
// the isolate is recycled. Nothing is wrong with the code; the option just should not be
// on that menu.

import { test, expect } from 'bun:test';
import { storageRegistry } from '../src/engine/providers/core.js';
import { configFromEnv, createServer } from '../src/index.js';
import { MemoryStorage, StorageDriverRegistry } from '@3sln/trove/core';

const ADMIN = 'boss@example.com';
const asAdmin = { 'x-user': ADMIN };

test('with nothing set, every registered driver stays', () => {
  expect(storageRegistry({}).keys()).toEqual(['s3', 'memory']);
});

test('an allow-list narrows the set, keeping registration order', () => {
  const extra = { key: 'acme.tape', create: () => new MemoryStorage() };
  expect(storageRegistry({ storageDrivers: [extra] }).keys()).toEqual(['s3', 'memory', 'acme.tape']);
  // The list is an allow-list, not an ordering — the menu keeps the order the entry point
  // registered in, so it does not reshuffle when an operator rewrites the variable.
  expect(storageRegistry({ storageDrivers: [extra], allowedStorageDrivers: ['acme.tape', 's3'] }).keys())
    .toEqual(['s3', 'acme.tape']);
});

test('it narrows drivers the entry point added, not only the portable ones', () => {
  // Otherwise a Node deployment could not decline Filesystem, which is the one driver
  // whose presence depends on the entry point in the first place.
  const fsLike = { key: 'filesystem', create: () => new MemoryStorage() };
  expect(storageRegistry({ storageDrivers: [fsLike], allowedStorageDrivers: ['s3'] }).keys())
    .toEqual(['s3']);
});

test('a name that matches nothing throws instead of narrowing to nothing', () => {
  // A typo that left a drive unable to create any collection at all would be a puzzle.
  expect(() => storageRegistry({ allowedStorageDrivers: ['s4'] }))
    .toThrow(/names "s4", which is not a driver this deployment has: s3, memory/);
  expect(() => storageRegistry({ allowedStorageDrivers: ['s3', 'nope', 'alsonope'] }))
    .toThrow(/"nope", "alsonope", which are not drivers/);
});

test('an injected registry is left exactly as it was given', () => {
  // Passing a registry is the full-control path: the caller built the set deliberately and
  // an env var must not quietly edit it.
  const mine = new StorageDriverRegistry([{ key: 'only', create: () => new MemoryStorage() }]);
  expect(storageRegistry({ storageRegistry: mine, allowedStorageDrivers: ['s3'] })).toBe(mine);
  expect(storageRegistry({ storageDrivers: mine, allowedStorageDrivers: ['s3'] })).toBe(mine);
});

test('TROVE_STORAGE_DRIVERS is read from the environment', () => {
  expect(configFromEnv({ TROVE_STORAGE_DRIVERS: 's3' }).allowedStorageDrivers).toEqual(['s3']);
  // Written by a human in a wrangler.toml, so tolerate the spacing they will use.
  expect(configFromEnv({ TROVE_STORAGE_DRIVERS: ' s3 , memory ,' }).allowedStorageDrivers)
    .toEqual(['s3', 'memory']);
  // Absent means "no opinion", which is not the same as "none".
  expect(configFromEnv({}).allowedStorageDrivers).toBeUndefined();
  expect(configFromEnv({ TROVE_STORAGE_DRIVERS: '' }).allowedStorageDrivers).toBeUndefined();
});

/**
 * A drive restricted to S3, with a header-authenticated admin.
 *
 * Deliberately does NOT inject a CollectionService: the server's own builds its
 * `storageFactory` from the registry, and that is the path under test. An injected one
 * brings its own factory and would bypass the restriction entirely — which is correct
 * (a caller who supplies the service owns the decision) and useless as a test of this.
 */
async function drive() {
  return createServer({
    rebuildIndexOnStart: false,
    admins: [ADMIN],
    defaultOpen: false,
    allowedStorageDrivers: ['s3'],
    identity: { driver: 'header', header: { idHeader: 'x-user', required: false } },
  });
}

test('a restricted drive offers only what it allows, and refuses the rest', async () => {
  const d = await drive();
  const caps = await (await d.handle(new Request('https://drive.test/api/capabilities', { headers: asAdmin }))).json();
  // The form renders from this, so taking a driver off the menu is the same act as
  // refusing it — the two cannot drift apart.
  expect(caps.storageDrivers.map((x) => x.key)).toEqual(['s3']);

  const res = await d.handle(new Request('https://drive.test/api/collections', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...asAdmin },
    body: JSON.stringify({ name: 'Scratch', store: { driver: 'memory' } }),
  }));
  // Refused rather than quietly built, and it says what this deployment does have. Refused
  // AT CREATION, not at the first upload — a collection that exists and cannot store
  // anything is the failure this whole mechanism is about.
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toMatch(/Unknown storage driver "memory".*has: s3/);
});

test('an S3 collection is still creatable on a restricted drive', async () => {
  // The restriction must not be a drive that refuses everything.
  const d = await drive();
  const res = await d.handle(new Request('https://drive.test/api/collections', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...asAdmin },
    body: JSON.stringify({
      name: 'Photos',
      store: { driver: 's3', bucket: 'b', accessKeyId: 'a', secretAccessKey: 'x', endpoint: 'https://e.test' },
    }),
  }));
  expect(res.status).toBe(200);
  expect((await res.json()).collection.driver).toBe('s3');
});
