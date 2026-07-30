// API keys grant capabilities and never identity.
//
// The properties worth pinning are mostly negative: what a key must NOT be able to do,
// and what the store must NOT retain. A key that works is easy; a key that quietly works
// on the wrong collection is the failure this file exists to catch.

import { test, expect } from 'bun:test';
import {
  ApiKeyService, ApiKeyCapabilityProvider, ANY_COLLECTION, CAPABILITIES, MemoryKV,
} from '../src/index.js';

const svc = (now) => new ApiKeyService({ kv: new MemoryKV(), ...(now ? { now } : {}) });
const bearer = (token) => new Request('https://drive.test/api/items', {
  headers: { authorization: `Bearer ${token}` },
});

test('the secret is returned once and never stored', async () => {
  const keys = svc();
  const { record, secret } = await keys.mint({
    name: 'CI', scopes: [{ collectionId: 'c1', capabilities: ['read'] }],
  });

  expect(secret.startsWith('trv_key_')).toBe(true);
  // Nothing handed back to a caller carries the hash, and nothing carries the secret.
  expect(record.hash).toBeUndefined();
  expect(JSON.stringify(record)).not.toContain(secret);
  expect(JSON.stringify(await keys.list())).not.toContain(secret);

  // And what IS stored cannot be replayed: it is a digest, not the credential.
  const stored = await keys.kv.get('api-keys', record.id);
  expect(stored.hash).toBeTruthy();
  expect(stored.hash).not.toBe(secret);
  expect(stored.secret).toBeUndefined();
});

test('a key is scoped to the collections it names', async () => {
  const keys = svc();
  const { secret } = await keys.mint({
    name: 'reader', scopes: [{ collectionId: 'photos', capabilities: ['read'] }],
  });
  const grant = await keys.verify(secret);

  expect(grant.can('photos', 'read')).toBe(true);
  // Not a higher capability on the collection it does hold…
  expect(grant.can('photos', 'write')).toBe(false);
  expect(grant.can('photos', 'admin')).toBe(false);
  // …and nothing at all on one it does not name. This is the whole point: a leaked key
  // for one collection must not be a key for the drive.
  expect(grant.can('invoices', 'read')).toBe(false);
  expect(grant.capabilitiesFor('invoices').size).toBe(0);
});

test('drive-wide access has to be asked for by name', async () => {
  const keys = svc();
  const { secret } = await keys.mint({
    name: 'everything', scopes: [{ collectionId: ANY_COLLECTION, capabilities: ['read'] }],
  });
  const grant = await keys.verify(secret);
  expect(grant.can('anything-at-all', 'read')).toBe(true);
  expect(grant.can('anything-at-all', 'write')).toBe(false);
});

test('admin in a key means what admin means in an ACL', async () => {
  // Two implication tables would eventually disagree, and the disagreement would be a
  // key that is more powerful than the UI that minted it said.
  const keys = svc();
  const { secret } = await keys.mint({
    name: 'root', scopes: [{ collectionId: 'c1', capabilities: ['admin'] }],
  });
  const grant = await keys.verify(secret);
  expect([...grant.capabilitiesFor('c1')].sort()).toEqual([...CAPABILITIES].sort());
});

test('per-collection scopes do not bleed into each other', async () => {
  const keys = svc();
  const { secret } = await keys.mint({
    name: 'mixed',
    scopes: [
      { collectionId: 'photos', capabilities: ['read'] },
      { collectionId: 'inbox', capabilities: ['read', 'write'] },
    ],
  });
  const grant = await keys.verify(secret);
  expect(grant.can('inbox', 'write')).toBe(true);
  expect(grant.can('photos', 'write')).toBe(false);
});

test('every way of presenting a bad credential fails the same way', async () => {
  const keys = svc();
  const { secret } = await keys.mint({
    name: 'k', scopes: [{ collectionId: 'c1', capabilities: ['read'] }],
  });

  // One flipped character, an unknown id, and assorted malformed shapes. All null, so a
  // caller cannot tell "no such key" from "wrong secret" — which would enumerate ids.
  const flipped = secret.slice(0, -1) + (secret.endsWith('a') ? 'b' : 'a');
  for (const bad of [
    flipped,
    'trv_key_deadbeefdeadbeef_nope',
    'trv_key_',
    'trv_key',
    'trv_',
    'nonsense',
    '',
    null,
    undefined,
    12345,
  ]) {
    expect(await keys.verify(bad)).toBeNull();
  }
});

test('revoking is permanent and keeps the record', async () => {
  const keys = svc();
  const { record, secret } = await keys.mint({
    name: 'doomed', scopes: [{ collectionId: 'c1', capabilities: ['read'] }],
  });
  expect(await keys.verify(secret)).toBeTruthy();

  const revoked = await keys.revoke(record.id);
  expect(revoked.revokedAt).toBeTruthy();
  expect(await keys.verify(secret)).toBeNull();

  // The record survives, because "why did this stop working" is worth being able to
  // answer, and a deleted id could be reissued.
  expect((await keys.list()).map((k) => k.id)).toContain(record.id);
  // Revoking twice is not an error.
  expect((await keys.revoke(record.id)).revokedAt).toBe(revoked.revokedAt);
});

test('an expired key stops verifying without anything having to sweep it', async () => {
  let clock = 1_000_000;
  const keys = svc(() => clock);
  const { secret } = await keys.mint({
    name: 'short-lived',
    scopes: [{ collectionId: 'c1', capabilities: ['read'] }],
    expiresAt: clock + 60_000,
  });
  expect(await keys.verify(secret)).toBeTruthy();
  clock += 60_001;
  expect(await keys.verify(secret)).toBeNull();
});

test('a key has to be worth minting', async () => {
  const keys = svc();
  const scopes = [{ collectionId: 'c1', capabilities: ['read'] }];
  await expect(keys.mint({ scopes })).rejects.toThrow(/name/i);
  await expect(keys.mint({ name: '   ', scopes })).rejects.toThrow(/name/i);
  await expect(keys.mint({ name: 'k' })).rejects.toThrow(/scope/i);
  await expect(keys.mint({ name: 'k', scopes: [] })).rejects.toThrow(/scope/i);
  await expect(keys.mint({ name: 'k', scopes: [{ collectionId: 'c1', capabilities: [] }] }))
    .rejects.toThrow(/no capabilities/i);
  await expect(keys.mint({ name: 'k', scopes: [{ capabilities: ['read'] }] }))
    .rejects.toThrow(/collectionId/i);
  // A typo'd capability is refused rather than silently ignored — otherwise a key
  // intended to grant `delete` would be minted granting nothing and appear to work.
  await expect(keys.mint({ name: 'k', scopes: [{ collectionId: 'c1', capabilities: ['destroy'] }] }))
    .rejects.toThrow(/Unknown capability/i);
  await expect(keys.mint({ name: 'k', scopes, expiresAt: 1 })).rejects.toThrow(/future/i);
});

test('last-used is recorded, and failing to record it is not fatal', async () => {
  let clock = 5_000;
  const keys = svc(() => clock);
  const { record } = await keys.mint({
    name: 'k', scopes: [{ collectionId: 'c1', capabilities: ['read'] }],
  });
  expect((await keys.get(record.id)).lastUsedAt).toBeNull();
  clock = 9_000;
  await keys.touch(record.id);
  expect((await keys.get(record.id)).lastUsedAt).toBe(9_000);

  // A broken store must not turn a working request into a failed one.
  keys.kv.get = async () => { throw new Error('kv is down'); };
  await keys.touch(record.id); // resolves
});

test('the provider claims our credentials and leaves everyone else alone', async () => {
  const keys = svc();
  const { secret } = await keys.mint({
    name: 'k', scopes: [{ collectionId: 'c1', capabilities: ['read'] }],
  });
  const provider = new ApiKeyCapabilityProvider({ apiKeys: keys });

  expect((await provider.resolve(bearer(secret))).name).toBe('k');

  // An OIDC access token is also `Authorization: Bearer`. Spending it on a key lookup
  // would turn a valid login into a failed one, so anything without our prefix is not
  // ours to answer for.
  expect(await provider.resolve(bearer('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.x.y'))).toBeNull();
  expect(await provider.resolve(new Request('https://drive.test/'))).toBeNull();
  expect(await provider.resolve(new Request('https://drive.test/', {
    headers: { authorization: 'Basic dXNlcjpwYXNz' },
  }))).toBeNull();
});

test('a grant carries no identity', async () => {
  // The property the whole design rests on: there is no principal in here to mistake
  // for a user, so nothing downstream can attribute a key's action to a person.
  const keys = svc();
  const { secret } = await keys.mint({
    name: 'k', scopes: [{ collectionId: 'c1', capabilities: ['read'] }], createdBy: 'ray@example.com',
  });
  const grant = await keys.verify(secret);
  expect(grant.kind).toBe('api-key');
  expect(grant.principal).toBeUndefined();
  expect(grant.id).toBeUndefined();
  expect(grant.email).toBeUndefined();
  // The minter is on the RECORD (an audit trail), not on the grant (an authorization).
  expect((await keys.list())[0].createdBy).toBe('ray@example.com');
});

test('list is newest first and hides hashes', async () => {
  let clock = 1000;
  const keys = svc(() => clock);
  const scopes = [{ collectionId: 'c1', capabilities: ['read'] }];
  await keys.mint({ name: 'first', scopes });
  clock = 2000;
  await keys.mint({ name: 'second', scopes });

  const listed = await keys.list();
  expect(listed.map((k) => k.name)).toEqual(['second', 'first']);
  for (const k of listed) expect(k.hash).toBeUndefined();
});

test('using a key records that it was used', async () => {
  // The UI shows "never used", which is how an admin finds the key nobody needs. It has
  // to actually be true — resolving a credential is the only place that knows.
  let clock = 1_000;
  const keys = svc(() => clock);
  const { record, secret } = await keys.mint({
    name: 'k', scopes: [{ collectionId: 'c1', capabilities: ['read'] }],
  });
  const provider = new ApiKeyCapabilityProvider({ apiKeys: keys });

  clock = 7_000;
  await provider.resolve(bearer(secret));
  // `touch` is deliberately not awaited by resolve, so let the microtask queue drain.
  await new Promise((r) => setTimeout(r, 0));
  expect((await keys.get(record.id)).lastUsedAt).toBe(7_000);
});

test('a credential of ours that does not verify is a 401, not anonymous', async () => {
  const keys = svc();
  const provider = new ApiKeyCapabilityProvider({ apiKeys: keys });
  // Serving a revoked key as the public is how a revocation goes unnoticed.
  await expect(provider.resolve(bearer('trv_key_deadbeefdeadbeef_nope'))).rejects.toThrow(/not valid/i);
});
