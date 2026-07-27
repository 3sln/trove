// Enforcement decides from configuration, never from presence.
//
// The distinction is the difference between a check and a suggestion. These are
// the same sentence, and they are not the same thing:
//
//   if (!ctx.collections) return;                 // "nothing here, so allow"
//   if (config.collections === false) return;     // "no ACL layer configured"
//
// They agree while everything is wired correctly and diverge exactly when it is
// not — and the first one stops enforcing at the worst possible moment. That is
// not hypothetical: `if (!ctx.plugins) return` in the contributor-namespace
// check guarded a condition that CANNOT occur (plugins is always built), so the
// only behaviour it ever had was to fail open when a dependency went undeclared.
// Any authenticated caller could then contribute under any vendor's name.

import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createServer, configFromEnv } from '../src/index.js';

const ENV = { TROVE_STORAGE: 'memory' };
// Comments stripped: the prose below quotes the very pattern being searched for,
// and a scanner that cannot tell code from a paragraph about code reports itself.
const ROUTES = fs.readFileSync(path.resolve(import.meta.dir, '../src/routes.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('no access check stands down because a service is missing', () => {
  // Only the shape matters here, so this is deliberately blunt: a bare falsiness
  // test on a leased resource, inside the access helpers, is the bug.
  const guards = [...ROUTES.matchAll(/if \(!ctx\.(collections|plugins|identity|kv|sqlite)\)[^\n]*/g)]
    .map((m) => m[0].trim());
  expect(guards).toEqual([]);
});

test('a service that is absent throws rather than waving the request through', async () => {
  // "Just let it error" is the right answer for a resource that should be there.
  // What must never happen is the check quietly passing.
  const server = await createServer(configFromEnv(ENV));
  const item = await server.vfs.writeFile('x.md', 'hi', { contentType: 'text/markdown' });

  // Stand in for a broken graph: the service is there but cannot answer, while
  // configuration still says this drive enforces plugin ownership.
  const original = server.plugins.assertInstalled;
  server.plugins.assertInstalled = () => { throw new Error('service unavailable'); };

  const res = await server.handle(new Request(`http://t/api/index/${encodeURIComponent('trove+contrib:ghost.example/p/idx')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId: item.id, tags: { a: 1 } }),
  }));
  expect(res.status).not.toBe(200);

  server.plugins.assertInstalled = original;
  await server.close();
});

test('an unowned contributor namespace is refused', async () => {
  // The check the fail-open guard was disabling.
  const server = await createServer(configFromEnv(ENV));
  const item = await server.vfs.writeFile('y.md', 'hi', { contentType: 'text/markdown' });
  const res = await server.handle(new Request(`http://t/api/index/${encodeURIComponent('trove+contrib:ghost.example/p/idx')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId: item.id, tags: { a: 1 } }),
  }));
  expect(res.status).toBe(403);
  await server.close();
});

test('turning collections off is a configuration decision, and it works', async () => {
  // The legitimate case the presence check was standing in for. It has to keep
  // working, or "read config instead" would just be a stricter server.
  const server = await createServer({ ...configFromEnv(ENV), collections: false });
  const res = await server.handle(new Request('http://t/api/collections'));
  expect(res.status).toBe(200);
  expect((await res.json()).collections[0].id).toBe('default');

  const write = await server.handle(new Request('http://t/api/items/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'nope', newName: 'x' }),
  }));
  // Refused for not existing, NOT for permissions — the ACL layer is off.
  expect(write.status).toBe(404);
  await server.close();
});
