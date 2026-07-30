// Which items get encrypted, and what a collection says about its key.

import { test, expect } from 'bun:test';
import { normalizeEncryption, shouldEncrypt, describeEncryption } from '../src/encryption/policy.js';
import { CollectionService, MemoryKV, MemoryStorage, describeKey } from '../src/index.js';

const KDF = { name: 'PBKDF2-SHA256', iterations: 1000 };
const enc = (rules) => normalizeEncryption({
  enabled: true, salt: 'aa'.repeat(16), fingerprint: 'bb'.repeat(16), kdf: KDF, rules,
});

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
  expect(() => normalizeEncryption({ enabled: true, rules: { all: true } }))
    .toThrow(/needs a salt and a key fingerprint/);
  expect(() => normalizeEncryption({ enabled: true, salt: 'aa', fingerprint: 'nope', rules: { all: true } }))
    .toThrow(/Not a key fingerprint/);
});

test('what a client is told is enough to derive and useless without the passphrase', async () => {
  const { config } = await describeKey('a good passphrase', { kdf: KDF });
  const e = normalizeEncryption({ ...config, enabled: true, rules: { all: true } });
  const shown = describeEncryption(e);
  expect(shown.salt).toBe(config.salt);
  expect(shown.fingerprint).toBe(config.fingerprint);
  expect(shown.kdf.iterations).toBe(1000);
  expect(JSON.stringify(shown)).not.toContain('a good passphrase');
});

// --- through the collection service --------------------------------------------

async function svc() {
  return new CollectionService({
    kv: new MemoryKV(), storageFactory: () => new MemoryStorage(), admins: ['boss'],
  });
}
const BOSS = { id: 'boss', email: 'boss@example.com', roles: [] };

test('a collection can be created encrypted, and says so', async () => {
  const s = await svc();
  const { config } = await describeKey('hunter2', { kdf: KDF });
  const c = await s.create({
    name: 'Private', store: { driver: 'memory' },
    encryption: { ...config, enabled: true, rules: { mimeTypes: ['image'] } },
  }, BOSS);
  expect(c.encryption.fingerprint).toBe(config.fingerprint);
  expect(c.encryption.rules.mimeTypes).toEqual(['image']);
});

test('an unencrypted collection reports null rather than an absent field', async () => {
  // So a client has one question to ask, not two.
  const s = await svc();
  const c = await s.create({ name: 'Open', store: { driver: 'memory' } }, BOSS);
  expect(c.encryption).toBe(null);
});

test('changing the key on a collection is refused, because it would orphan everything', async () => {
  // Every stored object names the key it was encrypted with. Swapping the collection's
  // fingerprint without re-encrypting leaves all of them pointing at a key nobody holds.
  const s = await svc();
  const first = await describeKey('hunter2', { kdf: KDF });
  const c = await s.create({
    name: 'Private', store: { driver: 'memory' },
    encryption: { ...first.config, enabled: true, rules: { all: true } },
  }, BOSS);

  const second = await describeKey('a different key', { kdf: KDF });
  await expect(s.update(c.id, {
    encryption: { ...second.config, enabled: true, rules: { all: true } },
  }, BOSS)).rejects.toThrow(/Rotate the key instead/);
});

test('the rules can be changed without touching the key', async () => {
  const s = await svc();
  const { config } = await describeKey('hunter2', { kdf: KDF });
  const c = await s.create({
    name: 'Private', store: { driver: 'memory' },
    encryption: { ...config, enabled: true, rules: { mimeTypes: ['image'] } },
  }, BOSS);
  const updated = await s.update(c.id, {
    encryption: { ...config, enabled: true, rules: { all: true } },
  }, BOSS);
  expect(updated.encryption.rules.all).toBe(true);
  expect(updated.encryption.fingerprint).toBe(config.fingerprint);
});

test('encryption can be switched off, and nothing already stored changes', async () => {
  // Turning it off must not imply decrypting what exists: each object records its own
  // envelope, so old items keep opening and new ones are stored in the clear.
  const s = await svc();
  const { config } = await describeKey('hunter2', { kdf: KDF });
  const c = await s.create({
    name: 'Private', store: { driver: 'memory' },
    encryption: { ...config, enabled: true, rules: { all: true } },
  }, BOSS);
  const off = await s.update(c.id, { encryption: { enabled: false } }, BOSS);
  expect(off.encryption).toBe(null);
});

// --- the key the server keeps --------------------------------------------------

test('setting a passphrase stores a key the server can use, and never shows it', async () => {
  // This is the deliberate limit of the design: the server holds the key, because it has
  // to hand it to a client in a transfer plan and decrypt for an indexer. It defends the
  // bucket, not the server. What it must never do is let that key out through the API.
  const s = await svc();
  const c = await s.create({
    name: 'Private', store: { driver: 'memory' },
    encryption: { userKey: 'a good long passphrase', rules: { all: true } },
  }, BOSS);

  const key = await s.dataKeyFor(c.id);
  expect(key.length).toBe(32);

  // Not in what a client is handed, in any shape.
  const shown = JSON.stringify(c);
  expect(shown).not.toContain('a good long passphrase');
  expect(shown).not.toContain(Buffer.from(key).toString('hex'));
  expect(c.encryption.fingerprint).toMatch(/^[0-9a-f]{32}$/);

  // Nor in the list.
  const listed = JSON.stringify(await s.list(BOSS));
  expect(listed).not.toContain(Buffer.from(key).toString('hex'));
});

test('setting the same passphrase again is idempotent, not a silent key change', async () => {
  // Re-derived against the collection's existing salt. Without that, "confirm the key"
  // would generate a new salt, a new key, and orphan everything already stored.
  const s = await svc();
  const c = await s.create({
    name: 'Private', store: { driver: 'memory' },
    encryption: { userKey: 'hunter2', rules: { all: true } },
  }, BOSS);
  const first = Buffer.from(await s.dataKeyFor(c.id)).toString('hex');

  const again = await s.update(c.id, {
    encryption: { userKey: 'hunter2', rules: { mimeTypes: ['image'] } },
  }, BOSS);
  expect(again.encryption.fingerprint).toBe(c.encryption.fingerprint);
  expect(Buffer.from(await s.dataKeyFor(c.id)).toString('hex')).toBe(first);
  // ...while the rules did change.
  expect(again.encryption.rules.mimeTypes).toEqual(['image']);
});

test('a different passphrase is refused rather than quietly orphaning everything', async () => {
  const s = await svc();
  const c = await s.create({
    name: 'Private', store: { driver: 'memory' },
    encryption: { userKey: 'hunter2', rules: { all: true } },
  }, BOSS);
  await expect(s.update(c.id, {
    encryption: { userKey: 'something else', rules: { all: true } },
  }, BOSS)).rejects.toThrow(/rotate the key instead/i);
});

test('an unencrypted collection has no key to give out', async () => {
  const s = await svc();
  const c = await s.create({ name: 'Open', store: { driver: 'memory' } }, BOSS);
  expect(await s.dataKeyFor(c.id)).toBe(null);
  expect(await s.encryptionFor(c.id)).toBe(null);
});
