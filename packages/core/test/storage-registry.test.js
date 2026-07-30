// Which backing stores a deployment can have is data, not a switch statement.
//
// The two failures this replaces are worth naming, because both looked like success:
// a typo'd driver built an in-memory store that accepted writes and lost them, and the
// collection form offered a filesystem on a runtime that has none.

import { test, expect } from 'bun:test';
import { StorageDriverRegistry, portableDrivers, MemoryStorage, StorageBackend } from '../src/index.js';
import { filesystemDriver } from '../src/storage/filesystem.js';

test('a typo is refused, and says what it could have been', async () => {
  // The old `default:` arm returned MemoryStorage for anything it did not recognise.
  const registry = new StorageDriverRegistry(portableDrivers());
  expect(() => registry.build({ driver: 'flesystem', root: '/tmp/x' }))
    .toThrow(/Unknown storage driver "flesystem"/);
  // And it names the alternatives, because "unknown driver" without a list is a puzzle.
  expect(() => registry.build({ driver: 'nope' })).toThrow(/s3, memory/);
});

test('a driver has to be named at all', () => {
  const registry = new StorageDriverRegistry(portableDrivers());
  expect(() => registry.build({})).toThrow(/needs a driver/);
  expect(() => registry.build()).toThrow(/needs a driver/);
});

test('what is not registered cannot be built', () => {
  // This is the whole availability mechanism: a Workers entry point registers the
  // portable drivers and never imports the filesystem one, so Filesystem is absent
  // rather than present-and-refused — and absent from the bundle too.
  const workersLike = new StorageDriverRegistry(portableDrivers());
  expect(workersLike.keys()).toEqual(['s3', 'memory']);
  expect(() => workersLike.build({ driver: 'filesystem', root: '/tmp/x' })).toThrow(/Unknown storage driver/);

  const nodeLike = new StorageDriverRegistry([...portableDrivers(), filesystemDriver()]);
  expect(nodeLike.keys()).toContain('filesystem');
});

test('required fields are enforced before a backend is built', () => {
  const registry = new StorageDriverRegistry(portableDrivers());
  // A bucket-less S3 store would otherwise fail later, on the first upload, as something
  // much less obviously a configuration problem.
  expect(() => registry.build({ driver: 's3', accessKeyId: 'a', secretAccessKey: 'b' }))
    .toThrow(/requires "bucket"/);
  expect(() => registry.build({ driver: 's3', bucket: 'b', secretAccessKey: 'b' }))
    .toThrow(/requires "accessKeyId"/);
});

test('a driver can come from outside this package', () => {
  // The point of the registry: the config lives in the collection record, the
  // implementation does not have to live here.
  class Custom extends StorageBackend {}
  const registry = new StorageDriverRegistry(portableDrivers());
  registry.register({
    key: 'acme.tape',
    label: 'Tape robot',
    fields: [{ name: 'library', label: 'Library', required: true }],
    create: () => new Custom(),
  });
  expect(registry.build({ driver: 'acme.tape', library: 'LTO-9' })).toBeInstanceOf(Custom);
  expect(() => registry.build({ driver: 'acme.tape' })).toThrow(/requires "library"/);
});

test('two drivers cannot claim one key', () => {
  // Overwriting would mean the one in use depends on registration order, and the loser
  // is silently not the one being built.
  const registry = new StorageDriverRegistry(portableDrivers());
  expect(() => registry.register({ key: 's3', create: () => new MemoryStorage() }))
    .toThrow(/already registered as "s3"/);
});

test('a driver has to be able to build something', () => {
  const registry = new StorageDriverRegistry();
  expect(() => registry.register({ key: 'x' })).toThrow(/create\(config\)/);
  expect(() => registry.register({ create: () => new MemoryStorage() })).toThrow(/needs a key/);
  // And what it returns has to be a StorageBackend, or the failure surfaces much later
  // as a missing method on something the drive assumed was a store.
  registry.register({ key: 'liar', create: () => ({ notAStore: true }) });
  expect(() => registry.build({ driver: 'liar' })).toThrow(/did not return a StorageBackend/);
});

test('descriptors carry what a form needs, and no implementation', () => {
  const described = new StorageDriverRegistry(portableDrivers()).describe();
  const s3 = described.find((d) => d.key === 's3');
  expect(s3.label).toBeTruthy();
  // Serialisable — it goes over the wire in /api/capabilities.
  expect(s3.create).toBeUndefined();
  expect(() => JSON.stringify(described)).not.toThrow();
  // Credentials are marked, so a client renders them as passwords and knows never to
  // expect them back.
  expect(s3.fields.find((f) => f.name === 'secretAccessKey').secret).toBe(true);
  expect(s3.fields.find((f) => f.name === 'bucket').required).toBe(true);
});
