// Retrying an upload, automatically and by hand.
//
// Two separate mechanisms, and the split matters because one cannot do the other's job:
//
//   Automatic retry covers what a second attempt plausibly fixes — a dropped connection,
//   a 5xx, a rate limit. Multipart PARTS already had it; create, the single presigned PUT
//   and complete did not, so the more common path (anything small enough for one PUT) had
//   no retry at all while the rarer one was covered.
//
//   Manual retry covers what it cannot. A lost upload session is `notFound`, correctly
//   classified non-retryable — no number of automatic attempts will conjure it back, and
//   pretending otherwise just delays the error. Someone has to decide to start over.

import { test, expect } from './testkit.js';
import { TroveApiClient } from '../src/platform/api.js';
import { TransfersService } from '../src/bl/services.js';

/** A fetch that fails `failures` times with `status`, then succeeds with `body`. */
function flakyFetch(failures, status, body) {
  const calls = { n: 0 };
  const fn = async () => {
    calls.n++;
    if (calls.n <= failures) {
      return new Response(JSON.stringify({ error: { code: 'transient', message: 'nope' } }), {
        status, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

test('creating the upload session is retried, not abandoned on the first stumble', async () => {
  // `create` is the first request an upload makes. It had no retry, so a single 503 on a
  // busy server ended an upload before a byte moved.
  const fetch = flakyFetch(2, 503, { uploadId: 'up_1', strategy: 'single', url: 'https://store.test/put', transfer: {} });
  const client = new TroveApiClient({ fetch });
  const plan = await client.request('POST', '/api/collections/c/uploads', { body: {} });
  expect(plan.uploadId).toBe('up_1');
  expect(fetch.calls.n).toBe(3); // two failures, then the answer
});

test('a lost upload session is not retried, because it will never come back', async () => {
  // The failure that started all this. 404/notFound is non-retryable by classification,
  // and must stay that way: the session is gone, and hammering it only delays the error
  // the user has to act on.
  const calls = { n: 0 };
  const fetch = async () => {
    calls.n++;
    return new Response(
      JSON.stringify({ error: { code: 'not_found', message: 'Upload session not found' } }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  };
  const client = new TroveApiClient({ fetch });
  let err;
  try { await client.request('POST', '/api/uploads/up_1/complete', { body: {} }); } catch (e) { err = e; }
  expect(err.message).toBe('Upload session not found');
  expect(calls.n).toBe(1); // tried exactly once
});

// --- manual retry ------------------------------------------------------------

test('a failed transfer offers a retry, and it reuses the same row', async () => {
  const transfers = new TransfersService();
  let attempts = 0;
  const controller = { abort() {} };
  transfers.start('x1', 'notes.txt', 100, controller, { retry: () => { attempts++; } });
  transfers.finish('x1', 'error', 'Upload session not found');

  const row = transfers.state.items.find((t) => t.id === 'x1');
  expect(row.status).toBe('error');
  expect(row.retryable).toBe(true);

  transfers.retry('x1');
  expect(attempts).toBe(1);
  // One row, not two. A retry is another attempt at the thing already asked for, and a
  // tray that grew an entry per attempt would report one upload as four.
  expect(transfers.state.items.length).toBe(1);
});

test('restarting puts the row back in flight and clears the last failure', async () => {
  const transfers = new TransfersService();
  transfers.start('x1', 'notes.txt', 100, { abort() {} }, { retry: () => {} });
  transfers.progress('x1', { loaded: 50, total: 100, ratio: 0.5 });
  transfers.finish('x1', 'error', 'boom');

  transfers.restart('x1', { abort() {} });
  const row = transfers.state.items.find((t) => t.id === 'x1');
  expect(row.status).toBe('active');
  expect(row.error).toBe(null);
  // Progress resets: the bytes from the failed attempt are not evidence about this one.
  expect(row.loaded).toBe(0);
  expect(row.ratio).toBe(0);
});

test('a transfer with no way to be retried does not claim it can be', async () => {
  // Nothing should offer a button that cannot do anything — and the retry closes over the
  // File, so it is genuinely absent for a transfer that arrived some other way.
  const transfers = new TransfersService();
  transfers.start('x1', 'notes.txt', 100, { abort() {} });
  transfers.finish('x1', 'error', 'boom');
  expect(transfers.state.items[0].retryable).toBe(false);
  expect(transfers.retry('x1')).toBe(null);
});

test('an in-flight transfer cannot be retried out from under itself', async () => {
  const transfers = new TransfersService();
  let attempts = 0;
  transfers.start('x1', 'notes.txt', 100, { abort() {} }, { retry: () => { attempts++; } });
  expect(transfers.retry('x1')).toBe(null);
  expect(attempts).toBe(0);
});

test('dismissing a transfer releases the File it was holding', async () => {
  // The retry thunk closes over the File. Left in the map, a dismissed upload pins its
  // bytes in memory for the rest of the session.
  const transfers = new TransfersService();
  transfers.start('x1', 'notes.txt', 100, { abort() {} }, { retry: () => {} });
  transfers.finish('x1', 'error', 'boom');
  transfers.dismiss('x1');
  expect(transfers.retry('x1')).toBe(null);
  expect(transfers.state.items.length).toBe(0);
});

test('clearing finished transfers releases theirs too', async () => {
  const transfers = new TransfersService();
  transfers.start('a', 'a.txt', 10, { abort() {} }, { retry: () => {} });
  transfers.start('b', 'b.txt', 10, { abort() {} }, { retry: () => {} });
  transfers.finish('a', 'error', 'boom');
  transfers.clearDone();
  expect(transfers.state.items.map((t) => t.id)).toEqual(['b']);
  expect(transfers.retry('a')).toBe(null);
});
