// The drive's ACL, answering an identity provider.
//
// Two halves have to hold. The DECISION — whoever has read on a collection gets through and
// nobody else does — is ours, and is what these mostly test. The ENVELOPE is Cloudflare's,
// and the most this can do is prove we verify what we are sent and sign what we send with a
// key whose public half we publish.
//
// The security property worth naming: this endpoint answers "does this email have access",
// so it must refuse to answer anyone it cannot attribute. An unauthenticated caller getting
// a straight yes/no would be an enumeration oracle for the drive's user list.

import { test, expect } from 'bun:test';
import { createServer } from '../src/index.js';
import {
  CollectionService, MemoryKV, MemoryStorage, StaticJwks, signJwt, publicJwkOf, verifyJwt,
} from '@3sln/trove/core';

const ADMIN = 'boss@example.com';
const BOSS = { id: ADMIN, email: ADMIN, roles: [] };

/** RSA, because Access verifies these and refuses anything else — see the module header. */
async function rsaKeyPair() {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  return crypto.subtle.exportKey('jwk', kp.privateKey);
}

/** A drive whose external evaluation trusts `teamKey` as the caller. */
async function drive({ open = false } = {}) {
  const ourKey = await rsaKeyPair();
  const teamKey = await rsaKeyPair();
  const kv = new MemoryKV();
  const storage = new MemoryStorage();
  const collections = new CollectionService({
    kv, storageFactory: () => storage, admins: [ADMIN], defaultOpen: open,
  });
  const server = await createServer({
    rebuildIndexOnStart: false, collections,
    identity: { driver: 'header', header: { idHeader: 'x-user', required: false } },
    accessEvaluation: {
      privateJwk: ourKey,
      kid: 'k1',
      // The caller's keys, injected rather than fetched — the component takes a JWKS so a
      // test does not need Cloudflare present to exercise the verification.
      jwks: new StaticJwks([publicJwkOf(teamKey, { kid: 'team' })]),
    },
  });
  return { server, collections, ourKey, teamKey };
}

/** What Cloudflare posts: an assertion about the person trying to get in. */
const assert_ = (teamKey, claims) => signJwt(claims, { privateJwk: teamKey, kid: 'team' });

const evaluate = (server, token) => server.handle(new Request('https://d/api/access/evaluate', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
}));

/** Read the answer the way Cloudflare would: with the key we publish. */
async function answerOf(server, res) {
  const { token } = await res.json();
  const keysRes = await server.handle(new Request('https://d/api/access/keys'));
  const { keys } = await keysRes.json();
  return verifyJwt(token, { jwks: new StaticJwks(keys) });
}

test('someone with read on a collection is let through', async () => {
  const d = await drive();
  const c = await d.collections.create({ name: 'Shared', store: { driver: 'memory' } }, BOSS);
  await d.collections.setGrant(c.id, { type: 'user', subject: 'alice@example.com', capabilities: ['read'] }, BOSS);

  const res = await evaluate(d.server, await assert_(d.teamKey, { email: 'alice@example.com', nonce: 'n1' }));
  expect(res.status).toBe(200);
  const answer = await answerOf(d.server, res);
  expect(answer.success).toBe(true);
  // The nonce is echoed, which is how the caller ties an answer to its question.
  expect(answer.nonce).toBe('n1');
});

test('someone with no grant anywhere is not', async () => {
  const d = await drive();
  await d.collections.create({ name: 'Private', store: { driver: 'memory' } }, BOSS);
  const res = await evaluate(d.server, await assert_(d.teamKey, { email: 'nobody@example.com', nonce: 'n2' }));
  expect((await answerOf(d.server, res)).success).toBe(false);
});

test('a named drive admin is let through with no grant at all', async () => {
  // Admin is not a grant on any one collection, and the front door has to know that or the
  // person who administers the drive cannot reach it.
  const d = await drive();
  const res = await evaluate(d.server, await assert_(d.teamKey, { email: ADMIN, nonce: 'n3' }));
  expect((await answerOf(d.server, res)).success).toBe(true);
});

test('an assertion this drive cannot attribute is refused, not answered', async () => {
  // The enumeration oracle. A stranger who can reach the endpoint must not learn whether an
  // address has access — so an unverifiable assertion is an ERROR, not a `success:false`,
  // which would be an answer.
  const d = await drive();
  const stranger = await rsaKeyPair();
  const res = await evaluate(d.server, await assert_(stranger, { email: ADMIN, nonce: 'n4' }));
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(await res.json())).not.toContain('success');
});

test('the answer is RS256, which is the only thing Access accepts', async () => {
  const d = await drive();
  const res = await evaluate(d.server, await assert_(d.teamKey, { identity: { email: ADMIN }, nonce: 'n6' }));
  const { token } = await res.json();
  expect(JSON.parse(atob(token.split('.')[0])).alg).toBe('RS256');
  const keys = (await (await d.server.handle(new Request('https://d/api/access/keys'))).json()).keys;
  expect(keys[0].alg).toBe('RS256');
  expect(keys[0].kty).toBe('RSA');
});

test('the identity is read from claims.identity.email, where Access puts it', async () => {
  // Their reference implementation reads `claims.identity.email`, not a top-level `email`.
  const d = await drive();
  const c = await d.collections.create({ name: 'Shared', store: { driver: 'memory' } }, BOSS);
  await d.collections.setGrant(c.id, { type: 'user', subject: 'nested@example.com', capabilities: ['read'] }, BOSS);
  const res = await evaluate(d.server, await assert_(d.teamKey, { identity: { email: 'nested@example.com' }, nonce: 'n7' }));
  expect((await answerOf(d.server, res)).success).toBe(true);
});

test('the published keys are public only', async () => {
  const d = await drive();
  const res = await d.server.handle(new Request('https://d/api/access/keys'));
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.keys).toHaveLength(1);
  // `d` is the private scalar. Publishing it would hand anyone the ability to mint a yes.
  expect(body.keys[0].d).toBeUndefined();
  expect(body.keys[0].kid).toBe('k1');
  expect(JSON.stringify(body)).not.toContain(d.ourKey.d);
});

test('an open drive lets everyone through, because the ACL says so', async () => {
  const d = await drive({ open: true });
  await d.collections.ensure({ id: 'default', name: 'My Drive' });
  const res = await evaluate(d.server, await assert_(d.teamKey, { email: 'anyone@example.com', nonce: 'n5' }));
  expect((await answerOf(d.server, res)).success).toBe(true);
});

test('the routes do not exist at all when no key is configured', async () => {
  // Off means absent, not present-and-refusing.
  const kv = new MemoryKV();
  const storage = new MemoryStorage();
  const collections = new CollectionService({ kv, storageFactory: () => storage, admins: [ADMIN] });
  const server = await createServer({ rebuildIndexOnStart: false, collections });
  expect((await server.handle(new Request('https://d/api/access/keys'))).status).toBe(404);
});

test('configured drive admins are reported apart from the grants, and cannot be edited', async () => {
  // They come from TROVE_ADMINS, not from the ACL. `setGrant` cannot reach them, so a UI
  // that listed them among the grants would show a revoke button that does nothing.
  const d = await drive();
  const c = await d.collections.create({ name: 'Shared', store: { driver: 'memory' } }, BOSS);
  const res = await d.server.handle(new Request(`https://d/api/collections/${c.id}/grants`, {
    headers: { 'x-user': ADMIN },
  }));
  const body = await res.json();
  expect(body.admins).toContain(ADMIN);
  // …and the ACL itself holds only the creator grant, not the deployment's admin list.
  expect(body.grants.some((g) => g.subject === ADMIN && g.type === 'user')).toBe(true);
  expect(body.grants.every((g) => g.type !== 'config')).toBe(true);
});

test('the access endpoints answer on a drive that requires authentication', async () => {
  // The failure this pins, found by pointing Cloudflare at a real deployment: the drive
  // authenticates every /api/ request BEFORE routing, so these two answered 401 to the one
  // caller that can never hold a Trove session — Access itself. They authenticate by other
  // means (a signed assertion; a public key is not a secret), so they opt out.
  const ourKey = await rsaKeyPair();
  const teamKey = await rsaKeyPair();
  const kv = new MemoryKV();
  const storage = new MemoryStorage();
  const collections = new CollectionService({
    kv, storageFactory: () => storage, admins: [ADMIN], defaultOpen: false,
  });
  const server = await createServer({
    rebuildIndexOnStart: false, collections,
    // The shape of the deployed drive: a session is required for everything.
    identity: { driver: 'header', header: { idHeader: 'x-user', required: true } },
    accessEvaluation: {
      privateJwk: ourKey, kid: 'k1',
      jwks: new StaticJwks([publicJwkOf(teamKey, { kid: 'team' })]),
    },
  });

  // No credentials of any kind.
  const keys = await server.handle(new Request('https://d/api/access/keys'));
  expect(keys.status).toBe(200);
  expect((await keys.json()).keys[0].kty).toBe('RSA');

  const evald = await server.handle(new Request('https://d/api/access/evaluate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: await signJwt({ email: ADMIN, nonce: 'n8' }, { privateJwk: teamKey, kid: 'team' }) }),
  }));
  expect(evald.status).toBe(200);

  // …while everything else on the same drive still demands one.
  expect((await server.handle(new Request('https://d/api/collections'))).status).toBe(401);
});
