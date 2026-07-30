// The storage check at the HTTP boundary, and the part that makes it worth having: a
// problem that gets fixed stops being listed.
//
// A diagnostic whose warnings outlive their cause is worse than none — people learn to
// scroll past the list, and then the real one is invisible too.

import { test, expect } from 'bun:test';
import { createServer } from '../src/index.js';
import { CollectionService, MemoryKV, StorageBackend } from '@3sln/trove/core';

const ORIGIN = 'https://drive.test';
const ADMIN = 'boss@example.com';
const asAdmin = { 'x-user': ADMIN };

/** A store that presigns, so CORS applies — as S3 and R2 do. */
class DirectStore extends StorageBackend {
  get capabilities() {
    return { presignDownload: true };
  }
  async list() {
    return { items: [] };
  }
  async presignGet(key) {
    return `https://bucket.example.net/${key}`;
  }
}

/** A drive whose one collection is on a presigning store, with the network under test. */
async function drive(corsHeaders) {
  const kv = new MemoryKV();
  const store = new DirectStore();
  const collections = new CollectionService({
    kv, storageFactory: () => store, admins: [ADMIN],
    defaultOpen: false, defaultStore: { driver: 's3' },
  });
  // `headers` is swapped between checks, which is how "the admin fixed the bucket" is
  // expressed: same drive, same collection, different answer from the store.
  const state = { headers: corsHeaders, preflights: 0 };
  const server = await createServer({
    rebuildIndexOnStart: false,
    collections,
    identity: { driver: 'header', header: { idHeader: 'x-user', required: false } },
    // Counts preflights only. The check also issues a real GET, because exposeHeaders
    // belong on the actual response rather than the preflight — see core/storage/diagnose.
    fetch: async (url, init) => {
      if ((init?.method || 'GET') === 'OPTIONS') state.preflights += 1;
      return new Response(null, { status: 200, headers: state.headers });
    },
  });
  await collections.create({ name: 'Photos', store: { driver: 's3', bucket: 'b' } },
    { id: ADMIN, email: ADMIN, roles: [] });
  return { ...server, state };
}

const GOOD = {
  'access-control-allow-origin': ORIGIN,
  'access-control-allow-headers': 'content-type, range',
  'access-control-expose-headers': 'ETag, Content-Length, Content-Type, Content-Range, Accept-Ranges',
};

const check = (handle, headers = asAdmin) =>
  handle(new Request(`${ORIGIN}/api/diagnostics/storage`, { method: 'POST', headers }));
const listIssues = async (handle) =>
  (await (await handle(new Request(`${ORIGIN}/api/issues`, { headers: asAdmin }))).json()).issues;

test('a missing CORS policy becomes an issue with the fix attached', async () => {
  const d = await drive({}); // answers a preflight with no allow-origin: the real failure
  const res = await check(d.handle);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.checked).toBe(1);
  // The origin came from the request, so the check is against the origin browsers use.
  expect(body.corsChecked).toBe(true);
  expect(body.results[0].findings.map((f) => f.code)).toEqual(['cors-missing']);

  const issues = await listIssues(d.handle);
  const issue = issues.find((i) => i.id.startsWith('storage:'));
  expect(issue).toBeTruthy();
  expect(issue.severity).toBe('error');
  expect(issue.title).toContain('Photos');
  // The remedy is its own field, so a client can render it as something copyable rather
  // than as a paragraph the admin has to retype.
  expect(issue.remedy).toContain(ORIGIN);
  expect(issue.remedy).toContain('AllowedOrigins');
  // And it is retryable, because re-running the check is how you find out you fixed it.
  expect(issue.retryable).toBe(true);
});

test('fixing the bucket clears the issue', async () => {
  const d = await drive({});
  await check(d.handle);
  expect((await listIssues(d.handle)).some((i) => i.id.startsWith('storage:'))).toBe(true);

  // The admin applies the policy...
  d.state.headers = GOOD;
  const body = await (await check(d.handle)).json();
  expect(body.results[0].findings).toEqual([]);
  // ...and the warning goes away by itself. Nobody had to dismiss it.
  expect((await listIssues(d.handle)).some((i) => i.id.startsWith('storage:'))).toBe(false);
});

test('a check is a real preflight, not a question asked of the config', async () => {
  const d = await drive(GOOD);
  await check(d.handle);
  expect(d.state.preflights).toBe(1);
});

test('a broken policy is refused for a non-admin', async () => {
  const d = await drive({});
  // Findings name buckets and endpoints, and the remedy is a runbook for the drive's
  // infrastructure. That is not a read for whoever happens to hold a collection.
  const res = await check(d.handle, { 'x-user': 'mallory@example.com' });
  expect(res.status).toBe(403);
});

test('an anonymous request cannot run the check', async () => {
  const d = await drive({});
  expect((await check(d.handle, {})).status).toBe(403);
});

test('one warning per problem, and repeats do not multiply', async () => {
  const d = await drive({ ...GOOD, 'access-control-allow-headers': 'content-type' });
  await check(d.handle);
  await check(d.handle);
  const storageIssues = (await listIssues(d.handle)).filter((i) => i.id.startsWith('storage:'));
  // Keyed by (collection, code), so a check that runs every five minutes for a day is one
  // row with a count rather than 288 of them.
  expect(storageIssues.length).toBe(1);
  expect(storageIssues[0].count).toBe(2);
  // Ranged reads only — small files still open, so this must not read as an outage.
  expect(storageIssues[0].severity).toBe('warning');
});
