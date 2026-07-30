// Which items get encrypted, and what a collection says about its key.

import { test, expect } from 'bun:test';
import { normalizeEncryption, shouldEncrypt, describeEncryption } from '../src/encryption/policy.js';
import { CollectionService, MemoryKV, MemoryStorage, fingerprintHex } from '../src/index.js';

const FP = 'bb'.repeat(16);
const enc = (rules) => normalizeEncryption({ enabled: true, rules }, FP);

test('rules match by extension, case and dot insensitively', () => {
  const e = enc({ extensions: ['.PDF', 'docx'] });
  expect(shouldEncrypt(e, { name: 'report.pdf' })).toBe(true);
  expect(shouldEncrypt(e, { name: 'REPORT.PDF' })).toBe(true);
  expect(shouldEncrypt(e, { name: 'notes.docx' })).toBe(true);
  expect(shouldEncrypt(e, { name: 'notes.txt' })).toBe(false);
  // A dot in a directory-ish name must not be read as an extension.
  expect(shouldEncrypt(e, { name: 'no-extension' })).toBe(false);
});

test('a media type matches by its leading part too', () => {
  // How someone actually thinks about it: "encrypt my photos", not a list of every
  // image format that exists.
  const e = enc({ mimeTypes: ['image', 'application/pdf'] });
  expect(shouldEncrypt(e, { name: 'a.png', contentType: 'image/png' })).toBe(true);
  expect(shouldEncrypt(e, { name: 'a.heic', contentType: 'image/heic' })).toBe(true);
  expect(shouldEncrypt(e, { name: 'a.pdf', contentType: 'application/pdf' })).toBe(true);
  expect(shouldEncrypt(e, { name: 'a.txt', contentType: 'text/plain' })).toBe(false);
  // Parameters on the header are not part of the type.
  expect(shouldEncrypt(e, { name: 'a.png', contentType: 'image/png; charset=binary' })).toBe(true);
});

test('"all" means all', () => {
  const e = enc({ all: true });
  expect(shouldEncrypt(e, { name: 'anything', contentType: '' })).toBe(true);
});

test('a collection that is not encrypted encrypts nothing', () => {
  expect(shouldEncrypt(null, { name: 'a.pdf' })).toBe(false);
  expect(normalizeEncryption({ enabled: false })).toBe(null);
  expect(describeEncryption(null)).toBe(null);
});

test('encryption that would match nothing is refused', () => {
  // Otherwise every upload is stored in the clear on a collection labelled encrypted —
  // the worst of both, and silent.
  expect(() => enc({})).toThrow(/no file would match/);
  expect(() => enc({ extensions: [], mimeTypes: [] })).toThrow(/no file would match/);
});

test('key material has to be coherent', () => {
  // A collection recorded as encrypted with no fingerprint is one whose objects could
  // never be matched to a key.
  expect(() => normalizeEncryption({ enabled: true, rules: { all: true } }))
    .toThrow(/needs a key fingerprint/);
  expect(() => normalizeEncryption({ enabled: true, rules: { all: true } }, 'nope'))
    .toThrow(/Not a key fingerprint/);
});

test('what a client is told names the key without being it', async () => {
  const shown = describeEncryption(enc({ all: true }));
  expect(shown.fingerprint).toBe(FP);
  expect(shown.enabled).toBe(true);
  // No salt, no KDF, no key — there is nothing to derive and nothing to prompt for.
  expect(Object.keys(shown).sort()).toEqual(['enabled', 'fingerprint', 'rules']);
});

// --- through the collection service --------------------------------------------

async function svc() {
  return new CollectionService({
    kv: new MemoryKV(), storageFactory: () => new MemoryStorage(), admins: ['boss'],
  });
}
const BOSS = { id: 'boss', email: 'boss@example.com', roles: [] };
const encrypted = (s, rules = { all: true }) => s.create({
  name: 'Private', store: { driver: 'memory' }, encryption: { enabled: true, rules },
}, BOSS);

test('enabling encryption mints a key, and the collection names it', async () => {
  const s = await svc();
  const c = await encrypted(s, { mimeTypes: ['image'] });
  expect(c.encryption.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  expect(c.encryption.rules.mimeTypes).toEqual(['image']);
  const key = await s.dataKeyFor(c.id);
  expect(key.length).toBe(32);
  expect(fingerprintHex(await (await import('../src/encryption/keys.js')).fingerprint(key)))
    .toBe(c.encryption.fingerprint);
});

test('the key is never in what a client is handed', async () => {
  // The deliberate limit of the design is that the SERVER holds the key. It reaches a
  // client through a transfer plan, authorized per operation — never through a listing.
  const s = await svc();
  const c = await encrypted(s);
  const key = Buffer.from(await s.dataKeyFor(c.id)).toString('hex');
  expect(JSON.stringify(c)).not.toContain(key);
  expect(JSON.stringify(await s.list(BOSS))).not.toContain(key);
});

test('an unencrypted collection has no key and says so', async () => {
  const s = await svc();
  const c = await s.create({ name: 'Open', store: { driver: 'memory' } }, BOSS);
  expect(c.encryption).toBe(null);
  expect(await s.dataKeyFor(c.id)).toBe(null);
  expect(await s.keyRingFor(c.id)).toEqual([]);
});

test('changing the rules keeps the key', async () => {
  // Minting a new one would orphan every object already sealed with the old.
  const s = await svc();
  const c = await encrypted(s, { mimeTypes: ['image'] });
  const before = Buffer.from(await s.dataKeyFor(c.id)).toString('hex');
  const after = await s.update(c.id, { encryption: { enabled: true, rules: { all: true } } }, BOSS);
  expect(after.encryption.fingerprint).toBe(c.encryption.fingerprint);
  expect(Buffer.from(await s.dataKeyFor(c.id)).toString('hex')).toBe(before);
  expect(after.encryption.rules.all).toBe(true);
});

test('switching encryption off decrypts nothing, and keeps the ring', async () => {
  // Objects already stored name their own key; dropping it would make them unreadable.
  const s = await svc();
  const c = await encrypted(s);
  const off = await s.update(c.id, { encryption: { enabled: false } }, BOSS);
  expect(off.encryption).toBe(null);
  expect((await s.keyRingFor(c.id)).length).toBe(1);
});

// --- rotation ------------------------------------------------------------------

test('rotation mints a new current key and keeps the old one live', async () => {
  // The point of a ring: until every object has moved, both keys must open things.
  const s = await svc();
  const c = await encrypted(s);
  const old = c.encryption.fingerprint;

  const r = await s.beginRotation(c.id, BOSS);
  expect(r.previous).toBe(old);
  expect(r.fingerprint).not.toBe(old);

  const ring = await s.keyRingFor(c.id);
  expect(ring.length).toBe(2);
  expect(ring[0].current).toBe(true);
  expect(ring[0].fingerprint).toBe(r.fingerprint);
  // The old key is still there, and still resolvable by name.
  expect(await s.dataKeyFor(c.id, old)).toBeTruthy();
  // And the collection now seals new objects with the new one.
  const now = (await s.list(BOSS)).find((x) => x.id === c.id);
  expect(now.encryption.fingerprint).toBe(r.fingerprint);
});

test('a key is retired only once nothing needs it', async () => {
  const s = await svc();
  const c = await encrypted(s);
  const old = c.encryption.fingerprint;
  const r = await s.beginRotation(c.id, BOSS);

  // The current key cannot be dropped — that would leave the collection sealing with
  // something it cannot open.
  await expect(s.retireKey(c.id, r.fingerprint, BOSS)).rejects.toThrow(/current key/);

  expect(await s.retireKey(c.id, old, BOSS)).toEqual({ retired: true });
  expect(await s.dataKeyFor(c.id, old)).toBe(null);
  expect((await s.keyRingFor(c.id)).length).toBe(1);
});

test('retiring a key that is already gone is not an error', async () => {
  // Rotation can be resumed after a failure, so finishing twice has to be harmless.
  const s = await svc();
  const c = await encrypted(s);
  await s.beginRotation(c.id, BOSS);
  await s.retireKey(c.id, c.encryption.fingerprint, BOSS);
  expect(await s.retireKey(c.id, c.encryption.fingerprint, BOSS)).toEqual({ retired: false });
});

test('rotation needs a collection that is actually encrypted', async () => {
  const s = await svc();
  const c = await s.create({ name: 'Open', store: { driver: 'memory' } }, BOSS);
  await expect(s.beginRotation(c.id, BOSS)).rejects.toThrow(/not encrypted/);
});
