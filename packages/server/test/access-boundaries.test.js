// The boundary a multi-user drive rests on: you see your collections and nobody else's.
//
// Each of these was a working exploit. They share a shape worth naming — a check that
// is present, looks right, and is defeated by an EMPTY value. "No collections readable"
// and "no scoping requested" are opposite instructions that both arrive as a falsy
// length, and conflating them turned an access check into a full index dump.

import { test, expect } from 'bun:test';
import { createServer } from '../src/index.js';
import { CollectionService, MemoryKV, MemoryStorage, assertSafePluginSql } from '@trove/core';

const ORIGIN = 'http://drive.test';
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
const b64url = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function sign(claims) {
  const input = `${enc({ alg: 'ES256', typ: 'JWT', kid: 'k1' })}.${enc({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

async function drive() {
  const kv = new MemoryKV();
  const collections = new CollectionService({
    kv, storageFactory: () => new MemoryStorage(), admins: ['boss@example.com'],
    defaultOpen: false, defaultStore: { driver: 'memory' },
  });
  const server = await createServer({
    rebuildIndexOnStart: false, collections,
    identity: { driver: 'jwt', jwt: { jwks: { keys: [publicJwk] }, required: true } },
  });
  const boss = { id: 'boss@example.com', email: 'boss@example.com', roles: [] };
  const priv = await collections.create({ name: 'Private', store: { driver: 'memory' } }, boss);
  const node = await server.vfs.writeFile('salaries.csv', 'name,pay\nalice,999999\n',
    { collectionId: priv.id, contentType: 'text/csv' });
  await server.vfs.metadata.setContribution(node.id, 'user', { tags: { secret: 'yes' } });
  return { ...server, priv, mallory: await sign({ sub: 'mallory@example.com', email: 'mallory@example.com' }) };
}

const post = (handle, path, body, token) => handle(new Request(`${ORIGIN}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}));

test('a user with nothing readable gets nothing, not everything', async () => {
  // `readableCollectionIds` returns [] for "you may see nothing". The metadata stores
  // tested `collectionIds?.length`, so [] read as "don't scope" — and a tag search with
  // no filters then dumped every item on the drive: names, ids, storage keys, tags, and
  // the text indexer's content excerpt.
  const { handle, mallory } = await drive();

  const mine = await (await handle(new Request(`${ORIGIN}/api/collections`, { headers: { authorization: `Bearer ${mallory}` } }))).json();
  expect(mine.collections).toEqual([]); // she really can see nothing

  for (const [path, payload] of [
    ['/api/tags/search', { collection: 'nope', filters: [] }],
    ['/api/tags/search', { filters: [{ key: 'secret', present: true }] }],
    ['/api/query', { q: '#secret', collection: 'nope' }],
  ]) {
    const res = await post(handle, path, payload, mallory);
    const text = await res.text();
    expect(text).not.toContain('salaries.csv');
    expect(text).not.toContain('999999');
  }
});

test('and the same holds for a collection that does not exist', async () => {
  // Naming a nonexistent collection produces the same empty set as naming a forbidden
  // one, so it is the same hole reached by a different route.
  const { handle, mallory } = await drive();
  const res = await post(handle, '/api/query', { q: 'salaries', collection: 'does-not-exist' }, mallory);
  expect(await res.text()).not.toContain('salaries.csv');
});

test('an owner still sees their own collection', async () => {
  // The fix must not scope everyone out of everything.
  const { handle, priv } = await drive();
  const boss = await sign({ sub: 'boss@example.com', email: 'boss@example.com' });
  const res = await post(handle, '/api/tags/search', { filters: [{ key: 'secret', present: true }], collection: priv.id }, boss);
  expect(await res.text()).toContain('salaries.csv');
});

test('plugin SQL cannot write a file anywhere on the host', async () => {
  // VACUUM INTO writes a complete SQLite database — pages full of rows the caller chose
  // — to any path the process can create. Attacker-chosen bytes at an attacker-chosen
  // path is a cron file, a webroot, an authorized_keys.
  expect(() => assertSafePluginSql("VACUUM INTO '/tmp/stolen.db'")).toThrow();
  expect(() => assertSafePluginSql('vacuum  into "/tmp/x"')).toThrow();
  // PRAGMA discloses the absolute on-disk path of the scope database, and some forms
  // move where files land.
  expect(() => assertSafePluginSql('PRAGMA database_list')).toThrow();
  expect(() => assertSafePluginSql("ATTACH DATABASE 'other' AS o")).toThrow();
  // Ordinary plugin SQL still works.
  expect(() => assertSafePluginSql('SELECT * FROM notes WHERE id = ?')).not.toThrow();
  expect(() => assertSafePluginSql("INSERT INTO notes VALUES ('vacuum cleaner')")).not.toThrow();
});

test('a plugin may only open the domain store of its own domain', async () => {
  // A plugin id is `<domain>/<name>`, so the domain it is entitled to is derivable —
  // and letting the caller name one meant reading another vendor's shared store.
  const { handle, mallory } = await drive();
  const res = await post(handle, '/api/plugins/evil.com%2Fspy/sql',
    { scope: 'domain', domain: 'acme.com', op: 'all', sql: 'SELECT 1' }, mallory);
  expect(res.status).toBe(403);
  expect((await res.json()).error.message).toMatch(/domain store/);
});

test('the MCP endpoint does not approve every origin', async () => {
  // On the zero-config deployment MCP needs no token, so a blanket CORS approval let any
  // page the user was visiting call write_file and delete_file on their drive.
  const { handle } = await createServer({ rebuildIndexOnStart: false });
  const res = await handle(new Request(`${ORIGIN}/mcp`, {
    method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
  }));
  expect(res.headers.get('access-control-allow-origin')).toBe(null);

  // And it follows the same allowlist the JSON API does when one is configured.
  const open = await createServer({ rebuildIndexOnStart: false, corsOrigin: 'https://good.example' });
  const ok = await open.handle(new Request(`${ORIGIN}/mcp`, {
    method: 'OPTIONS', headers: { origin: 'https://good.example', 'access-control-request-method': 'POST' },
  }));
  expect(ok.headers.get('access-control-allow-origin')).toBe('https://good.example');
  const nope = await open.handle(new Request(`${ORIGIN}/mcp`, {
    method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
  }));
  expect(nope.headers.get('access-control-allow-origin')).toBe(null);
});
