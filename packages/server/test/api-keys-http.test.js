// API keys at the HTTP boundary.
//
// api-keys.test.js proves the credential model in isolation. This proves the wiring: that
// a key actually authorizes a request, that it is confined to what it was scoped to, and
// that it cannot be used to widen itself.

import { test, expect } from 'bun:test';
import { createServer } from '../src/index.js';
import { CollectionService, MemoryKV, MemoryStorage } from '@3sln/trove/core';

const ORIGIN = 'https://drive.test';
const ADMIN = 'boss@example.com';

/** A drive with two collections and a header-authenticated admin. */
async function drive() {
  const kv = new MemoryKV();
  const collections = new CollectionService({
    kv, storageFactory: () => new MemoryStorage(), admins: [ADMIN],
    defaultOpen: false, defaultStore: { driver: 'memory' },
  });
  const server = await createServer({
    rebuildIndexOnStart: false, collections,
    identity: { driver: 'header', header: { idHeader: 'x-user', required: false } },
  });
  const boss = { id: ADMIN, email: ADMIN, roles: [] };
  const photos = await collections.create({ name: 'Photos', store: { driver: 'memory' } }, boss);
  const invoices = await collections.create({ name: 'Invoices', store: { driver: 'memory' } }, boss);
  return { ...server, photos, invoices };
}

const asAdmin = { 'x-user': ADMIN };
const withKey = (secret) => ({ authorization: `Bearer ${secret}` });

const get = (handle, path, headers = {}) => handle(new Request(`${ORIGIN}${path}`, { headers }));
const post = (handle, path, body, headers = {}) => handle(new Request(`${ORIGIN}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body ?? {}),
}));
const del = (handle, path, headers = {}) =>
  handle(new Request(`${ORIGIN}${path}`, { method: 'DELETE', headers }));

async function mint(handle, spec) {
  const res = await post(handle, '/api/keys', spec, asAdmin);
  expect(res.status).toBe(200);
  return res.json();
}

test('an admin can mint a key and the secret is shown exactly once', async () => {
  const d = await drive();
  const { key, secret } = await mint(d.handle, {
    name: 'photo reader', scopes: [{ collectionId: d.photos.id, capabilities: ['read'] }],
  });
  expect(secret.startsWith('trv_key_')).toBe(true);
  expect(key.createdBy).toBe(ADMIN);

  // Listing it again never returns the secret or its hash.
  const listed = await (await get(d.handle, '/api/keys', asAdmin)).json();
  const found = listed.keys.find((k) => k.id === key.id);
  expect(found).toBeTruthy();
  expect(JSON.stringify(listed)).not.toContain(secret);
  expect(found.hash).toBeUndefined();
});

test('a key authorizes the collection it names, and only that one', async () => {
  const d = await drive();
  const { secret } = await mint(d.handle, {
    name: 'photo reader', scopes: [{ collectionId: d.photos.id, capabilities: ['read'] }],
  });

  // Reading the scoped collection works with no session at all.
  const ok = await get(d.handle, `/api/collections/${d.photos.id}/items`, withKey(secret));
  expect(ok.status).toBe(200);

  // The other collection is refused, even though the same admin minted the key and
  // holds admin on both. The key's scope is the ceiling, not the minter's.
  const nope = await get(d.handle, `/api/collections/${d.invoices.id}/items`, withKey(secret));
  expect(nope.status).toBe(403);
});

test('a read key cannot write, and is refused rather than quietly narrowed', async () => {
  const d = await drive();
  const { secret } = await mint(d.handle, {
    name: 'photo reader', scopes: [{ collectionId: d.photos.id, capabilities: ['read'] }],
  });
  const res = await post(d.handle, `/api/collections/${d.photos.id}/uploads`,
    { name: 'x.txt', size: 1 }, withKey(secret));
  // 403, not a 200 that silently did nothing and not a handle with fewer capabilities.
  expect(res.status).toBe(403);
});

test('a write key can actually upload to its collection', async () => {
  const d = await drive();
  const { secret } = await mint(d.handle, {
    name: 'ingest', scopes: [{ collectionId: d.photos.id, capabilities: ['read', 'write'] }],
  });
  const res = await post(d.handle, `/api/collections/${d.photos.id}/uploads`,
    { name: 'note.txt', size: 5, contentType: 'text/plain' }, withKey(secret));
  expect(res.status).toBe(200);
  expect((await res.json()).uploadId).toBeTruthy();
});

test('a key carries no identity', async () => {
  const d = await drive();
  const { secret } = await mint(d.handle, {
    name: 'anon', scopes: [{ collectionId: d.photos.id, capabilities: ['read'] }],
  });
  const me = await (await get(d.handle, '/api/me', withKey(secret))).json();
  // Nobody is signed in. The request is authorized, and that is a different thing.
  expect(me.principal?.id).not.toBe(ADMIN);
  expect(me.admin).toBe(false);
});

test('a key cannot manage keys, however broadly it is scoped', async () => {
  const d = await drive();
  // Deliberately the most powerful key the API allows: admin on every collection.
  const { secret } = await mint(d.handle, {
    name: 'root', scopes: [{ collectionId: '*', capabilities: ['admin'] }],
  });

  // Still cannot read, mint or revoke keys. A key that could mint keys could outlive
  // its own revocation by issuing others before it was cut off.
  expect((await get(d.handle, '/api/keys', withKey(secret))).status).toBe(403);
  expect((await post(d.handle, '/api/keys',
    { name: 'child', scopes: [{ collectionId: '*', capabilities: ['admin'] }] }, withKey(secret))).status).toBe(403);
  expect((await del(d.handle, '/api/keys/key_whatever', withKey(secret))).status).toBe(403);
});

test('a non-admin cannot manage keys', async () => {
  const d = await drive();
  const asMallory = { 'x-user': 'mallory@example.com' };
  expect((await get(d.handle, '/api/keys', asMallory)).status).toBe(403);
  expect((await post(d.handle, '/api/keys',
    { name: 'x', scopes: [{ collectionId: '*', capabilities: ['admin'] }] }, asMallory)).status).toBe(403);
});

test('a revoked key stops working immediately', async () => {
  const d = await drive();
  const { key, secret } = await mint(d.handle, {
    name: 'temp', scopes: [{ collectionId: d.photos.id, capabilities: ['read'] }],
  });
  expect((await get(d.handle, `/api/collections/${d.photos.id}/items`, withKey(secret))).status).toBe(200);

  expect((await del(d.handle, `/api/keys/${key.id}`, asAdmin)).status).toBe(200);

  // 401, not 403: the credential is no longer a credential at all.
  const after = await get(d.handle, `/api/collections/${d.photos.id}/items`, withKey(secret));
  expect(after.status).toBe(401);
});

test('an invalid key is a 401, not a quiet downgrade to anonymous', async () => {
  const d = await drive();
  // Someone who sends a credential expects to be authorized by it. Serving them as the
  // public instead is how a revoked key looks like "works, but with less access".
  const res = await get(d.handle, '/api/me', withKey('trv_key_deadbeefdeadbeef_nonsense'));
  expect(res.status).toBe(401);
});

test('a foreign bearer token is left to the identity provider', async () => {
  const d = await drive();
  // Not ours — no `trv_` prefix. Must not be spent as a failed key lookup, or every
  // OIDC deployment breaks the moment API keys ship.
  const res = await get(d.handle, '/api/me', {
    authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.someones.jwt', ...asAdmin,
  });
  expect(res.status).toBe(200);
  expect((await res.json()).principal.id).toBe(ADMIN);
});

test('a key and a session are never combined', async () => {
  const d = await drive();
  const { secret } = await mint(d.handle, {
    name: 'weak', scopes: [{ collectionId: d.photos.id, capabilities: ['read'] }],
  });
  // The admin session would grant write on invoices; the key grants nothing there. Sent
  // together, the request must get the key's authority and not the union — the confused
  // deputy, arrived at by being accommodating.
  const res = await get(d.handle, `/api/collections/${d.invoices.id}/items`,
    { ...withKey(secret), ...asAdmin });
  expect(res.status).toBe(403);
});

// --- the routes that resolved the wrong subject -------------------------------
//
// Two authorization systems lived in routes.js and only the access providers knew what
// an API key was. `readableCollectionIds`, `assertCap` and `requireWholeDrive` handed
// `ctx.principal` — null on a key request — straight to CollectionService, so a key was
// evaluated as the anonymous caller. Both directions were wrong, and each of these
// asserts one of them.

test('a scoped key can search and list on a locked drive', async () => {
  // The refusal direction. `list(null)` is [] on a drive with no `anyone` grant, so a
  // correctly-scoped key was scoped to nothing: search, tags and backlinks all answered
  // 403 or "no results" for a collection the key plainly held `read` on.
  const d = await drive();
  const { secret } = await mint(d.handle, {
    name: 'photo reader', scopes: [{ collectionId: d.photos.id, capabilities: ['read'] }],
  });

  const listed = await (await get(d.handle, '/api/collections', withKey(secret))).json();
  expect(listed.collections.map((c) => c.id)).toEqual([d.photos.id]);
  // And the capabilities reported are the KEY's, not an anonymous principal's empty set.
  expect(listed.collections[0].capabilities).toContain('read');
  expect(listed.canCreate).toBe(false);

  const search = await get(d.handle, '/api/search?q=anything', withKey(secret));
  expect(search.status).toBe(200);
  const one = await get(d.handle, `/api/collections/${d.photos.id}`, withKey(secret));
  expect(one.status).toBe(200);
});

test('an open drive does not lend its anyone-grant to a narrowly scoped key', async () => {
  // The over-permit direction, and the one that matters. On a `defaultOpen` drive
  // `capabilities(null, c)` matches the `anyone` grant, so a key scoped to `photos`
  // silently read and wrote `invoices` through every route that asked the principal.
  const kv = new MemoryKV();
  const collections = new CollectionService({
    kv, storageFactory: () => new MemoryStorage(), admins: [ADMIN],
    defaultOpen: true, defaultStore: { driver: 'memory' },
  });
  const server = await createServer({
    rebuildIndexOnStart: false, collections,
    identity: { driver: 'header', header: { idHeader: 'x-user', required: false } },
  });
  const boss = { id: ADMIN, email: ADMIN, roles: [] };
  const photos = await collections.create({ name: 'Photos', store: { driver: 'memory' } }, boss);
  const invoices = await collections.create({ name: 'Invoices', store: { driver: 'memory' } }, boss);
  const { secret } = await mint(server.handle, {
    name: 'photo reader', scopes: [{ collectionId: photos.id, capabilities: ['read'] }],
  });

  const listed = await (await get(server.handle, '/api/collections', withKey(secret))).json();
  expect(listed.collections.map((c) => c.id)).toEqual([photos.id]);

  const other = await get(server.handle, `/api/collections/${invoices.id}`, withKey(secret));
  expect(other.status).toBe(403);

  // And it holds nothing drive-wide, however open the drive is to people.
  const reindex = await post(server.handle, '/api/reindex', {}, withKey(secret));
  expect(reindex.status).toBe(403);
});

test('a key cannot administer a collection, however broadly it is scoped', async () => {
  // Changing an ACL is the self-escalation shape: a key that can rewrite who may reach a
  // collection can grant itself whatever it lacks. Refused outright, like minting keys.
  const d = await drive();
  const { secret } = await mint(d.handle, {
    name: 'everything', scopes: [{ collectionId: '*', capabilities: ['admin'] }],
  });

  expect((await get(d.handle, `/api/collections/${d.photos.id}/grants`, withKey(secret))).status).toBe(403);
  expect((await post(d.handle, `/api/collections/${d.photos.id}/grants`,
    { type: 'anyone', capabilities: ['admin'] }, withKey(secret))).status).toBe(403);
  expect((await post(d.handle, '/api/collections',
    { name: 'Mine', store: { driver: 'memory' } }, withKey(secret))).status).toBe(403);
  expect((await del(d.handle, `/api/collections/${d.invoices.id}`, withKey(secret))).status).toBe(403);
});

test('a key scoped to every collection holds the drive-wide verbs', async () => {
  // `hasWholeDrive` is "can read and write everything that exists" — not the admin list.
  // Asked of the key rather than of the empty principal, a `*` read+write key satisfies
  // it, and a key scoped to one collection does not.
  const d = await drive();
  const wide = await mint(d.handle, {
    name: 'everything', scopes: [{ collectionId: '*', capabilities: ['read', 'write'] }],
  });
  const narrow = await mint(d.handle, {
    name: 'photos only', scopes: [{ collectionId: d.photos.id, capabilities: ['read', 'write'] }],
  });

  expect((await post(d.handle, '/api/reindex', {}, withKey(wide.secret))).status).toBe(200);
  expect((await post(d.handle, '/api/reindex', {}, withKey(narrow.secret))).status).toBe(403);
});
