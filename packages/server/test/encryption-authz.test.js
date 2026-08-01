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

test('no plan response contains anything key-shaped', async () => {
  // The escalation this used to close: ask for a plan for a four-byte file, receive the
  // means to decrypt the entire collection. It closed by refusing write-only callers; it is
  // closed now by there being no key in the response at all, for anyone.
  const d = await drive();
  const secret = await mintKey(d.handle, [{ collectionId: d.secret.id, capabilities: ['write'] }]);
  for (const headers of [{ authorization: `Bearer ${secret}` }, asAdmin]) {
    const res = await upload(d.handle, d.secret.id, headers);
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toMatch(/[0-9a-f]{64}/);
  }
});

test('a plan never carries a key, whoever asks', async () => {
  // The drive seals on the way to the store, so there is nothing readable in a plan and
  // nothing for a caller to leak.
  const d = await drive();
  const secret = await mintKey(d.handle, [{ collectionId: d.secret.id, capabilities: ['read', 'write'] }]);
  const res = await upload(d.handle, d.secret.id, { authorization: `Bearer ${secret}` });
  expect(res.status).toBe(200);
  const plan = await res.json();
  expect(plan.encryption.key).toBeUndefined();
  expect(plan.encryption.sealedBy).toBe('server');

  const asAdminPlan = await (await upload(d.handle, d.secret.id, asAdmin)).json();
  expect(asAdminPlan.encryption.key).toBeUndefined();
});

test('a write-only credential can upload to an encrypted collection again', async () => {
  // It could not, and the reason was the key: a plan handed it over, which made the plan a
  // read capability however it arrived, so `write` alone had to be refused. Nothing
  // readable travels now, so the write-only ingest credential the key model advertises
  // works where it always should have.
  const d = await drive();
  const secret = await mintKey(d.handle, [{ collectionId: d.secret.id, capabilities: ['write'] }]);
  const res = await upload(d.handle, d.secret.id, { authorization: `Bearer ${secret}` });
  expect(res.status).toBe(200);
  expect((await res.json()).encryption.key).toBeUndefined();
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
