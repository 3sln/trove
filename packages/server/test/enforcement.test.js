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
import { createServer, configFromEnv } from '../src/index.js';

const ENV = { TROVE_STORAGE: 'memory' };

test('a service that is absent throws rather than waving the request through', async () => {
  // "Just let it error" is the right answer for a resource that should be there.
  // What must never happen is the check quietly passing.
  const server = await createServer(configFromEnv(ENV));
  await server.collections?.ensure({ id: 'default', name: 'My Drive' });
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
  await server.collections?.ensure({ id: 'default', name: 'My Drive' });
  const item = await server.vfs.writeFile('y.md', 'hi', { contentType: 'text/markdown' });
  const res = await server.handle(new Request(`http://t/api/index/${encodeURIComponent('trove+contrib:ghost.example/p/idx')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId: item.id, tags: { a: 1 } }),
  }));
  expect(res.status).toBe(403);
  await server.close();
});

test('turning collections off is refused at boot, not per request', async () => {
  // This used to be the legitimate case the presence check stood in for: one open store,
  // no ACLs, `collections: false`. It cannot exist now — every collection-scoped endpoint
  // names its collection in the path, so an unnamed single store has nothing to answer.
  //
  // And it fails at startup rather than on the first request, which is the right moment:
  // an operator who mis-set this finds out while they are still looking at the terminal,
  // instead of from a user hitting a 500 later.
  await expect(createServer({ ...configFromEnv(ENV), collections: false }))
    .rejects.toThrow(/no longer supported/i);
});
