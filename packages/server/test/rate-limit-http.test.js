// Rate limiting at the HTTP boundary.
//
// core/test/rate-limit.test.js proves the counter. This proves the wiring: that the limit
// is charged to the right subject, that it refuses BEFORE the expensive work, that a
// refusal carries a `Retry-After` a client can act on, and that the cheap reads the shell
// issues constantly are not metered at all.

import { test, expect } from 'bun:test';
import { createServer, configFromEnv } from '../src/index.js';
import { CollectionService, MemoryKV, MemoryStorage } from '@3sln/trove/core';

const ORIGIN = 'https://drive.test';
const ADMIN = 'boss@example.com';
const asAdmin = { 'x-user': ADMIN };

async function drive({ limits, store, enabled = true } = {}) {
  const kv = new MemoryKV();
  const collections = new CollectionService({
    kv, storageFactory: () => new MemoryStorage(), admins: [ADMIN],
    defaultOpen: true, defaultStore: { driver: 'memory' },
  });
  const server = await createServer({
    rebuildIndexOnStart: false, collections,
    identity: { driver: 'header', header: { idHeader: 'x-user', required: false } },
    rateLimit: { enabled, store: store || 'memory', limits: limits || {} },
  });
  const boss = { id: ADMIN, email: ADMIN, roles: [] };
  const c = await collections.create({ name: 'Files', store: { driver: 'memory' } }, boss);
  return { ...server, collection: c };
}

const get = (handle, path, headers = {}) => handle(new Request(`${ORIGIN}${path}`, { headers }));

test('a caller past the search limit gets 429 with Retry-After', async () => {
  // Search is the one where an attacker spends the operator's money rather than their CPU:
  // with TROVE_EMBEDDINGS_URL set, every query is a paid third-party call.
  const d = await drive({ limits: { search: { limit: 2, windowMs: 60_000 } } });

  expect((await get(d.handle, '/api/search?q=a', asAdmin)).status).toBe(200);
  expect((await get(d.handle, '/api/search?q=b', asAdmin)).status).toBe(200);

  const refused = await get(d.handle, '/api/search?q=c', asAdmin);
  expect(refused.status).toBe(429);
  // A 429 without this makes every client guess. Seconds, rounded up, as RFC 9110 wants.
  expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
  const body = await refused.json();
  expect(body.error.code).toBe('quota');
  // Retryable is what distinguishes a rate limit from a full disk, which is 507 and is not.
  expect(body.error.retryable).toBe(true);
});

test('the limit is charged to the caller, not to the endpoint', async () => {
  const d = await drive({ limits: { search: { limit: 1, windowMs: 60_000 } } });
  expect((await get(d.handle, '/api/search?q=a', asAdmin)).status).toBe(200);
  expect((await get(d.handle, '/api/search?q=b', asAdmin)).status).toBe(429);
  // Somebody else still has their own budget.
  expect((await get(d.handle, '/api/search?q=b', { 'x-user': 'someone@else.test' })).status).toBe(200);
});

test('cheap reads are not metered', async () => {
  // A limit low enough to bite on listing would break normal use, which is the definition
  // of theatre. Only the classes a route names are charged at all.
  const d = await drive({ limits: { search: { limit: 1, windowMs: 60_000 } } });
  for (let i = 0; i < 20; i++) {
    expect((await get(d.handle, `/api/collections/${d.collection.id}/items`, asAdmin)).status).toBe(200);
  }
});

test('switching limiting off means no limiter at all, not an empty one', async () => {
  const d = await drive({ enabled: false, limits: { search: { limit: 1, windowMs: 60_000 } } });
  for (let i = 0; i < 5; i++) {
    expect((await get(d.handle, '/api/search?q=a', asAdmin)).status).toBe(200);
  }
});

test('capabilities reports what will actually be enforced, and at what scope', async () => {
  // The requirement this ticket ends on: a deployment that cannot enforce a limit says so
  // rather than appearing to. `scope` is that admission.
  const d = await drive({ limits: { search: { limit: 5, windowMs: 60_000 } } });
  const caps = await (await get(d.handle, '/api/capabilities', asAdmin)).json();
  expect(caps.rateLimits.enabled).toBe(true);
  expect(caps.rateLimits.scope).toBe('process');
  expect(caps.rateLimits.limits.search.limit).toBe(5);
});

test('configFromEnv refuses a limits document it cannot honour', async () => {
  // Falling back to the defaults would be an operator believing they had tightened
  // something they had not.
  const base = { TROVE_STORAGE: 'memory' };
  expect(configFromEnv(base).rateLimit.enabled).toBe(true);
  expect(configFromEnv({ ...base, TROVE_RATE_LIMIT: 'off' }).rateLimit.enabled).toBe(false);

  const tightened = configFromEnv({ ...base, TROVE_RATE_LIMITS: '{"search":{"limit":5}}' });
  expect(tightened.rateLimit.limits.search.limit).toBe(5);
  // Merged over the defaults, so naming one class keeps the rest — and keeps this class's
  // window, which the operator did not mention.
  expect(tightened.rateLimit.limits.search.windowMs).toBe(60_000);
  expect(tightened.rateLimit.limits.upload.limit).toBe(240);

  expect(() => configFromEnv({ ...base, TROVE_RATE_LIMITS: 'not json' })).toThrow(/not valid JSON/);
  expect(() => configFromEnv({ ...base, TROVE_RATE_LIMITS: '{"nonsense":{"limit":1}}' }))
    .toThrow(/Unknown rate-limit class/);
});
