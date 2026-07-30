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

test('a driver can be copied into another registry, create included', async () => {
  // `describe()` strips `create` because it answers a client; narrowing a deployment's set
  // needs the real thing. There is deliberately no `unregister` — a driver vanishing from a
  // live registry is a store that stops being buildable while collections still name it —
  // so narrowing rebuilds from what survived.
  const full = new StorageDriverRegistry(portableDrivers());
  const narrowed = new StorageDriverRegistry();
  narrowed.register(full.driver('s3'));
  expect(narrowed.keys()).toEqual(['s3']);
  expect(narrowed.build({ driver: 's3', bucket: 'b', accessKeyId: 'a', secretAccessKey: 'x' }))
    .toBeInstanceOf(StorageBackend);
  // And the copy is a real driver, not a description of one.
  expect(full.describe().find((d) => d.key === 's3').create).toBeUndefined();
  expect(typeof full.driver('s3').create).toBe('function');
});

test('the nested s3 config shape still builds — the one configFromEnv produces', async () => {
  // The regression this pins broke every environment-configured S3 deployment at startup,
  // production included: `TROVE_STORAGE=s3` puts the settings under `s3`, `create` spread
  // them back out, and the required-field check in between looked for a top-level `bucket`
  // that was never going to be there. "Storage driver "s3" requires "bucket"" on a drive
  // whose bucket was configured correctly.
  //
  // No test caught it because every one of them used the flat shape the form posts.
  const registry = new StorageDriverRegistry(portableDrivers());
  const fromEnv = {
    driver: 's3',
    s3: { bucket: 'trove', region: 'auto', endpoint: 'https://acct.r2.cloudflarestorage.com', accessKeyId: 'a', secretAccessKey: 'x' },
  };
  const store = registry.build(fromEnv);
  expect(store).toBeInstanceOf(StorageBackend);
  expect(store.cfg.bucket).toBe('trove');

  // Flat still works, and still validates.
  expect(registry.build({ driver: 's3', bucket: 'flat', accessKeyId: 'a', secretAccessKey: 'x' }).cfg.bucket).toBe('flat');
  // A nested config genuinely missing a bucket is still refused — normalising must not
  // turn validation off.
  expect(() => registry.build({ driver: 's3', s3: { accessKeyId: 'a', secretAccessKey: 'x' } }))
    .toThrow(/requires "bucket"/);
});

test('descriptors carry no behaviour at all', async () => {
  // `normalize` joined `create` as something a driver has and a client must not receive.
  const described = new StorageDriverRegistry(portableDrivers()).describe();
  for (const d of described) {
    for (const [k, v] of Object.entries(d)) expect(typeof v).not.toBe('function');
  }
  expect(JSON.parse(JSON.stringify(described)).find((d) => d.key === 's3').fields.length).toBe(7);
});
