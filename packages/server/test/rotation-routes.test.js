// Starting, watching and cancelling a key rotation over HTTP.
//
// The walker was complete and unreachable — no route, no schedule, so a rotation could not
// be started and one left running would never advance. These are the two halves of that.

import { test, expect } from 'bun:test';
import { createServer } from '../src/index.js';
import { CollectionService, MemoryKV, MemoryStorage } from '@3sln/trove/core';

const ORIGIN = 'https://drive.test';
const ADMIN = 'boss@example.com';
const asAdmin = { 'x-user': ADMIN };
const BOSS = { id: ADMIN, email: ADMIN, roles: [] };

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
  }, BOSS);
  const open = await collections.create({ name: 'Open', store: { driver: 'memory' } }, BOSS);
  return { ...server, collections, secret, open };
}

const call = (handle, method, path, headers = asAdmin) =>
  handle(new Request(`${ORIGIN}${path}`, { method, headers }));

test('an admin can start a rotation and read its state back', async () => {
  const d = await drive();
  const before = d.secret.encryption.fingerprint;

  const started = await call(d.handle, 'POST', `/api/collections/${d.secret.id}/rotate`);
  expect(started.status).toBe(200);
  const { rotation } = await started.json();
  expect(rotation.status).toBe('running');
  expect(rotation.to).not.toBe(before);
  expect(rotation.from).toContain(before);

  const read = await (await call(d.handle, 'GET', `/api/collections/${d.secret.id}/rotate`)).json();
  expect(read.rotation.to).toBe(rotation.to);
});

test('a collection that has never rotated answers null rather than 404', async () => {
  // A client polling for progress should not have to treat "never started" as an error.
  const d = await drive();
  const res = await call(d.handle, 'GET', `/api/collections/${d.secret.id}/rotate`);
  expect(res.status).toBe(200);
  expect((await res.json()).rotation).toBe(null);
});

test('a rotation can be cancelled, and what moved stays readable', async () => {
  const d = await drive();
  await call(d.handle, 'POST', `/api/collections/${d.secret.id}/rotate`);
  const res = await call(d.handle, 'DELETE', `/api/collections/${d.secret.id}/rotate`);
  expect(res.status).toBe(200);
  expect((await res.json()).rotation.cancelled).toBe(true);
  // Both keys are still in the ring, so nothing became unreadable.
  expect((await d.collections.keyRingFor(d.secret.id)).length).toBe(2);
});

test('an unencrypted collection has no key to rotate', async () => {
  const d = await drive();
  const res = await call(d.handle, 'POST', `/api/collections/${d.open.id}/rotate`);
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toMatch(/not encrypted/);
});

test('an API key cannot rotate a collection, however broadly scoped', async () => {
  // A credential that could re-key a collection could make its contents unreadable to
  // everyone still holding the old one. That is a decision for a person.
  const d = await drive();
  const minted = await (await d.handle(new Request(`${ORIGIN}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...asAdmin },
    body: JSON.stringify({ name: 'root', scopes: [{ collectionId: '*', capabilities: ['admin'] }] }),
  }))).json();
  const withKey = { authorization: `Bearer ${minted.secret}` };
  expect((await call(d.handle, 'POST', `/api/collections/${d.secret.id}/rotate`, withKey)).status).toBe(403);
  expect((await call(d.handle, 'GET', `/api/collections/${d.secret.id}/rotate`, withKey)).status).toBe(403);
  expect((await call(d.handle, 'DELETE', `/api/collections/${d.secret.id}/rotate`, withKey)).status).toBe(403);
});

test('a non-admin cannot rotate anything', async () => {
  const d = await drive();
  const res = await call(d.handle, 'POST', `/api/collections/${d.secret.id}/rotate`, { 'x-user': 'mallory@example.com' });
  expect(res.status).toBe(403);
});

test('the cost estimate is available before anyone commits to it', async () => {
  const d = await drive();
  const res = await call(d.handle, 'GET', `/api/collections/${d.secret.id}/rotate/estimate`);
  expect(res.status).toBe(200);
  const est = await res.json();
  // A memory store is not billed by anyone, so offering a price would invent a concern.
  expect(est.applicable).toBe(false);
  expect(est.summary).toMatch(/nobody bills you for/);
});

test('a rotation left running is advanced by maintenance', async () => {
  // Without this the walk only moves while somebody is watching, which is exactly wrong
  // for a job that can run for hours: the old key stays in the ring and nothing says why.
  const d = await drive();
  await call(d.handle, 'POST', `/api/collections/${d.secret.id}/rotate`);
  const out = await d.runMaintenance({ budgetMs: 2000, scan: true });
  expect(Array.isArray(out.rotated)).toBe(true);
  const mine = out.rotated.find((r) => r.collectionId === d.secret.id);
  expect(mine).toBeTruthy();
  expect(mine.status).toBe('done'); // nothing to move, so one pass finishes it
});

test('maintenance leaves collections with no rotation alone', async () => {
  const d = await drive();
  const out = await d.runMaintenance({ budgetMs: 2000, scan: true });
  expect(out.rotated).toEqual([]);
});
