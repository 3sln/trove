// Who is allowed the collection key.
//
// An upload onto an encrypted collection is handed that key so the client can seal the
// bytes before they reach the bucket. The key decrypts EVERYTHING in the collection, which
// makes it a read capability however it arrives — and `write` does not imply `read` here.
// Only `admin` expands.

import { test, expect } from 'bun:test';
import { createServer } from '../src/index.js';
import { CollectionService, MemoryKV, MemoryStorage } from '@3sln/trove/core';

const ORIGIN = 'https://drive.test';
const ADMIN = 'boss@example.com';
const asAdmin = { 'x-user': ADMIN };

async function drive() {
  const kv = new MemoryKV();
  const storage = new MemoryStorage();
  const collections = new CollectionService({
    kv, storageFactory: () => storage, admins: [ADMIN], defaultOpen: false,
  });
  const server = await createServer({
    rebuildIndexOnStart: false, collections,
    identity: { driver: 'header', header: { idHeader: 'x-user', required: false } },
  });
  const secret = await collections.create({
    name: 'Private', store: { driver: 'memory' }, encryption: { enabled: true, rules: { all: true } },
  }, { id: ADMIN, email: ADMIN, roles: [] });
  return { ...server, collections, secret };
}

const mintKey = async (handle, scopes) => {
  const res = await handle(new Request(`${ORIGIN}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...asAdmin },
    body: JSON.stringify({ name: 'k', scopes }),
  }));
  expect(res.status).toBe(200);
  return (await res.json()).secret;
};
const upload = (handle, collectionId, headers) => handle(new Request(
  `${ORIGIN}/api/collections/${collectionId}/uploads`,
  { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ name: 'x.txt', size: 4 }) },
));

test('a write-only key cannot obtain the collection key', async () => {
  // The escalation this closes: ask for a plan for a four-byte file, receive the means to
  // decrypt the entire collection. Write-only API keys are a supported scope, so this was
  // reachable rather than theoretical.
  const d = await drive();
  const secret = await mintKey(d.handle, [{ collectionId: d.secret.id, capabilities: ['write'] }]);
  const res = await upload(d.handle, d.secret.id, { authorization: `Bearer ${secret}` });
  expect(res.status).toBe(403);
  // And it is refused rather than quietly downgraded to a plaintext upload — storing in the
  // clear on a collection someone set up to encrypt is the worse outcome.
  expect(JSON.stringify(await res.json())).not.toMatch(/[0-9a-f]{64}/);
});

test('read and write together does get the key', async () => {
  const d = await drive();
  const secret = await mintKey(d.handle, [{ collectionId: d.secret.id, capabilities: ['read', 'write'] }]);
  const res = await upload(d.handle, d.secret.id, { authorization: `Bearer ${secret}` });
  expect(res.status).toBe(200);
  const plan = await res.json();
  expect(plan.encryption.key).toMatch(/^[0-9a-f]{64}$/);
});

test('an admin still gets it, because admin expands to everything', async () => {
  const d = await drive();
  const res = await upload(d.handle, d.secret.id, asAdmin);
  expect(res.status).toBe(200);
  expect((await res.json()).encryption.key).toMatch(/^[0-9a-f]{64}$/);
});

test('an unencrypted collection is unaffected by any of this', async () => {
  // A write-only ingest credential is a legitimate thing, and it keeps working where no key
  // would be handed over.
  const d = await drive();
  const open = await d.collections.create(
    { name: 'Drop box', store: { driver: 'memory' } }, { id: ADMIN, email: ADMIN, roles: [] },
  );
  const secret = await mintKey(d.handle, [{ collectionId: open.id, capabilities: ['write'] }]);
  const res = await upload(d.handle, open.id, { authorization: `Bearer ${secret}` });
  expect(res.status).toBe(200);
  expect((await res.json()).encryption).toBe(null);
});

test('the key never appears in a collection listing', async () => {
  const d = await drive();
  const key = Buffer.from(await d.collections.dataKeyFor(d.secret.id)).toString('hex');
  const listed = await (await d.handle(new Request(`${ORIGIN}/api/collections`, { headers: asAdmin }))).text();
  expect(listed).not.toContain(key);
  // The fingerprint does go out — it names the key without being it.
  expect(listed).toContain(d.secret.encryption.fingerprint);
});
