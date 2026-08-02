// What one caller may cost.
//
// The properties that matter: a limit that bites, a refusal a client can act on, one
// budget per subject rather than per request shape, and a window that actually reopens.

import { test, expect } from 'bun:test';
import {
  RateLimiter, MemoryRateStore, KvRateStore, rateSubject, describeRateLimits,
  DEFAULT_RATE_LIMITS, MemoryKV,
} from '../src/index.js';

const at = (t) => () => t;
const limits = { search: { limit: 3, windowMs: 1000 }, write: { limit: 100, windowMs: 1000 } };

test('a caller is refused once past the limit, and told exactly how long to wait', async () => {
  let clock = 5_400; // mid-window on purpose: the wait is to the window's END, not a fixed delay
  const rl = new RateLimiter({ store: new MemoryRateStore(), limits, now: () => clock });

  for (let i = 0; i < 3; i++) expect((await rl.check('user:a', 'search')).ok).toBe(true);
  const over = await rl.check('user:a', 'search');
  expect(over.ok).toBe(false);
  // 5400 sits inside the window [5000, 6000), so 600ms remain. A 429 without this makes
  // every client guess, and a client that guesses wrong either hammers or waits far too long.
  expect(over.retryAfterMs).toBe(600);

  // The window reopens on its own — there is nothing to reset, because the bucket is part
  // of the key. That is also what makes it safe across processes that never talk.
  clock = 6_000;
  expect((await rl.check('user:a', 'search')).ok).toBe(true);
});

test('the budget is per subject and per class, not one pool', async () => {
  const rl = new RateLimiter({ store: new MemoryRateStore(), limits, now: at(0) });
  for (let i = 0; i < 3; i++) await rl.check('user:a', 'search');
  expect((await rl.check('user:a', 'search')).ok).toBe(false);
  // Somebody else is unaffected …
  expect((await rl.check('user:b', 'search')).ok).toBe(true);
  // … and so is the same person doing something cheap. A limit that treats a range request
  // and a semantic search as one thing is either useless or absurd.
  expect((await rl.check('user:a', 'write')).ok).toBe(true);
});

test('an unmetered class is allowed, not refused', async () => {
  // A class nobody named is work nobody decided to meter — the reads the shell issues
  // constantly. Refusing them would be the opposite of the intent.
  const rl = new RateLimiter({ store: new MemoryRateStore(), limits, now: at(0) });
  for (let i = 0; i < 500; i++) expect((await rl.check('user:a', 'stat')).ok).toBe(true);
});

test('enforce refuses with 429 and a retryable error, not 507', async () => {
  // QUOTA covers two failures with different answers: a rate limit is "back off", being
  // out of disk is "retrying changes nothing". `retryable` is what tells them apart.
  const rl = new RateLimiter({ store: new MemoryRateStore(), limits, now: at(0) });
  for (let i = 0; i < 3; i++) await rl.enforce('user:a', 'search');
  try {
    await rl.enforce('user:a', 'search');
    throw new Error('should have refused');
  } catch (err) {
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.details.retryAfterMs).toBe(1000);
    expect(err.details.kind).toBe('search');
  }
});

test('the shared store counts one budget across instances', async () => {
  // The point of the KV store: on a runtime with more than one instance, memory counters
  // give each of them the whole limit.
  const kv = new MemoryKV();
  const one = new RateLimiter({ store: new KvRateStore({ kv }), limits, now: at(0) });
  const two = new RateLimiter({ store: new KvRateStore({ kv }), limits, now: at(0) });
  expect((await one.check('key:k1', 'search')).ok).toBe(true);
  expect((await two.check('key:k1', 'search')).ok).toBe(true);
  expect((await one.check('key:k1', 'search')).ok).toBe(true);
  expect((await two.check('key:k1', 'search')).ok).toBe(false);
});

test('expired buckets are swept, so the namespace does not grow forever', async () => {
  const kv = new MemoryKV();
  const store = new KvRateStore({ kv });
  await store.bump('search:user:a:0', 1000, 0);
  await store.bump('search:user:b:0', 1000, 0);
  expect((await kv.list(KvRateStore.NS)).length).toBe(2);
  // Nothing else removes them: the window passing makes a bucket unreachable, not absent.
  expect(await store.sweep(500)).toBe(0);
  expect(await store.sweep(2000)).toBe(2);
  expect((await kv.list(KvRateStore.NS)).length).toBe(0);
});

test('the subject is the key, then the person, and never a header we cannot trust', async () => {
  const grant = { keyId: 'ak_1' };
  const principal = { id: 'alice@example.com' };
  const req = new Request('http://d.test/', { headers: { 'x-forwarded-for': '9.9.9.9' } });

  expect(rateSubject({ grant, principal })).toBe('key:ak_1');
  expect(rateSubject({ principal })).toBe('user:alice@example.com');

  // With no credential and no trusted proxy, everyone anonymous shares ONE budget. That
  // bounds what the drive spends, which is the point — keying on a header a client can set
  // would hand every caller their own budget for the asking, which is worse than nothing.
  expect(rateSubject({ req })).toBe('anon');
  expect(rateSubject({ req, trustProxy: true })).toBe('ip:9.9.9.9');
});

test('a deployment says what it can actually enforce', async () => {
  // The requirement: a runtime that cannot enforce a limit says so rather than pretending.
  expect(describeRateLimits({ enabled: false })).toEqual({ enabled: false, scope: 'none', limits: {} });
  expect(describeRateLimits({ enabled: true, store: 'memory', limits: DEFAULT_RATE_LIMITS, perProcess: true }).scope)
    .toBe('process');
  // In-memory counters with no long-lived process count per isolate, so the effective limit
  // is the configured one times however many the platform runs.
  expect(describeRateLimits({ enabled: true, store: 'memory', limits: DEFAULT_RATE_LIMITS, perProcess: false }).scope)
    .toBe('isolate');
  expect(describeRateLimits({ enabled: true, store: 'kv', limits: DEFAULT_RATE_LIMITS, perProcess: false }).scope)
    .toBe('drive');
});

test('both stores sweep, so the caller never has to ask which one it got', async () => {
  // `store.sweep?.()` would be the optional-call shape this codebase records as having
  // turned a sweep into a permanent no-op once already. And without a periodic sweep, an
  // in-memory store on a quiet drive holds an expired bucket for every subject it has ever
  // seen until its size backstop fires, which may be never.
  const memory = new MemoryRateStore();
  await memory.bump('search:user:a:0', 1000, 0);
  await memory.bump('search:user:b:0', 1000, 0);
  expect(memory.buckets.size).toBe(2);
  expect(await memory.sweep(500)).toBe(0);
  expect(await memory.sweep(2000)).toBe(2);
  expect(memory.buckets.size).toBe(0);
});
