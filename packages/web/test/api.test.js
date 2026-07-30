// TroveApiClient.request retry classification: a 429/5xx that the server marks
// non-retryable (e.g. a per-file size limit) must fail fast with its REAL message,
// not be retried into a generic "Server 429".

import { test, expect } from './testkit.js';
import { TroveApiClient } from '../src/platform/api.js';

function fakeFetch(responses) {
  let i = 0;
  const calls = { n: 0 };
  const fn = async () => {
    calls.n++;
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(r.body ? JSON.stringify(r.body) : '', {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  fn.calls = calls;
  return fn;
}

test('a non-retryable 429 fails immediately with the server message', async () => {
  const fetch = fakeFetch([
    { status: 429, body: { error: { code: 'quota', message: 'File exceeds the maximum upload size of 1024 bytes', retryable: false } } },
  ]);
  const client = new TroveApiClient({ fetch });
  let err;
  try { await client.request('POST', '/api/collections/default/uploads', { body: { size: 99999 } }); } catch (e) { err = e; }
  expect(err).toBeDefined();
  expect(err.message).toContain('exceeds the maximum upload size');
  expect(err.code).toBe('quota');
  expect(fetch.calls.n).toBe(1); // NOT retried
});

test('a plain 4xx error surfaces its structured message', async () => {
  const fetch = fakeFetch([
    { status: 409, body: { error: { code: 'already_exists', message: 'A file named report.pdf already exists' } } },
  ]);
  const client = new TroveApiClient({ fetch });
  let err;
  try { await client.request('POST', '/api/items/nope', { body: {} }); } catch (e) { err = e; }
  expect(err.code).toBe('already_exists');
  expect(err.message).toContain('already exists');
  expect(fetch.calls.n).toBe(1);
});

test('a retryable 500 with no body is retried then surfaces a transient error', async () => {
  // 3 failures then it gives up (retries: 3 → 4 total attempts). Use empty bodies.
  const fetch = fakeFetch([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]);
  const client = new TroveApiClient({ fetch });
  let err;
  try { await client.request('GET', '/api/collections/default/items', {}); } catch (e) { err = e; }
  expect(err.code).toBe('transient');
  expect(fetch.calls.n).toBe(4); // 1 + 3 retries
});
