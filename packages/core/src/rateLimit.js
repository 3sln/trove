// What one caller may cost.
//
// There was no limit anywhere: a key, a signed-in person, or on an open drive a stranger,
// could issue requests as fast as they could open sockets and every one was served. That is
// survivable while the only user is whoever deployed it, and stops being survivable the
// moment a key is handed to somebody else's script or the drive is put somewhere reachable.
//
// REQUESTS ARE NOT EQUAL, so neither are the limits. A limit that treats a range request
// and a semantic search as the same thing is either useless against the expensive one or
// absurd against the cheap one. Work is named by CLASS, and a class is a statement about
// what one call can cost someone:
//
//   search    a paid third-party call per query where TROVE_EMBEDDINGS_URL is set. The one
//             where an attacker spends the operator's money rather than their CPU.
//   upload    bytes through the drive — and both directions for an encrypted collection,
//             since the drive seals. `maxUploadBytes` caps one file and nothing capped the
//             rate, so a thousand small uploads cost what the limit was meant to prevent.
//   download  bytes out. Generous, because a media player range-requests one file many
//             times and that is one file's worth of bandwidth, not many.
//   job       scan, reindex, rotate. Each schedules real work over a whole collection.
//   install   unzip, verify, store.
//   evaluate  the deliberately unauthenticated access endpoint: a JWKS fetch or cache read
//             and an RSA verify, reachable with no credential at all.
//   write     ordinary mutations. A backstop, not a real cost model.
//
// Reads are not limited. They are cheap, the shell issues many, and a limit low enough to
// matter would break normal use — which is the definition of theatre.
//
// WHERE THE COUNTERS LIVE is the hard part, and the honest answer differs by runtime. A
// per-process counter is exact on a long-lived Bun or Node instance and a lie on Workers,
// where each isolate has its own memory and "60 a minute" becomes 60 per isolate per
// minute. So there are two stores, the choice is configuration, and `describeRateLimits`
// exists so a deployment that cannot enforce them SAYS SO rather than appearing to.

import { TroveError } from './errors.js';

/**
 * `count/window` for each class of work.
 *
 * Generous enough that someone using the drive normally never sees a 429, tight enough
 * that a loop does. Windows are all a minute because a limit you have to reason about in
 * two units is one nobody reasons about.
 */
export const DEFAULT_RATE_LIMITS = {
  search: { limit: 60, windowMs: 60_000 },
  upload: { limit: 240, windowMs: 60_000 },
  download: { limit: 1200, windowMs: 60_000 },
  job: { limit: 10, windowMs: 60_000 },
  install: { limit: 10, windowMs: 60_000 },
  evaluate: { limit: 60, windowMs: 60_000 },
  write: { limit: 600, windowMs: 60_000 },
};

export const RATE_CLASSES = Object.keys(DEFAULT_RATE_LIMITS);

/**
 * Counters in this process's memory.
 *
 * EXACT on a runtime where one process serves every request, which is what a self-hosted
 * Bun or Node drive is. Wrong on Workers — see the module header, and `describeRateLimits`,
 * which is how a deployment finds out rather than assuming.
 *
 * Buckets expire, and expired ones are swept when the map grows rather than on a timer:
 * there is no timer to hang it on inside a request, and a sweep proportional to how much
 * traffic there was is the right shape anyway.
 */
export class MemoryRateStore {
  constructor({ maxEntries = 10_000 } = {}) {
    this.buckets = new Map(); // key -> { count, expiresAt }
    this.maxEntries = maxEntries;
  }

  async bump(key, windowMs, now) {
    if (this.buckets.size > this.maxEntries) {
      for (const [k, b] of this.buckets) if (b.expiresAt <= now) this.buckets.delete(k);
    }
    const held = this.buckets.get(key);
    if (held && held.expiresAt > now) {
      held.count += 1;
      return held.count;
    }
    this.buckets.set(key, { count: 1, expiresAt: now + windowMs });
    return 1;
  }
}

/**
 * Counters in the shared KeyValueStore, so every instance sees one budget.
 *
 * The cost is a read and a write per LIMITED request — which is why only the expensive
 * classes are limited at all. And it is read-modify-write rather than an atomic increment,
 * because the store has no atomic increment: requests that overlap exactly can each read
 * the same count and each write count+1, so a burst can slip a few through. That is a
 * limiter that is occasionally generous, which is a different thing from no limiter, and
 * it is stated here rather than discovered.
 *
 * Expired buckets are removed by `sweep`, called from periodic maintenance. Without it the
 * namespace grows one key per subject per class per window, forever.
 */
export class KvRateStore {
  static NS = 'ratelimit';

  constructor({ kv }) {
    if (!kv) throw TroveError.invalid('KvRateStore needs a KeyValueStore');
    this.kv = kv;
  }

  async bump(key, windowMs, now) {
    const held = await this.kv.get(KvRateStore.NS, key).catch(() => null);
    const next = held && held.expiresAt > now
      ? { count: held.count + 1, expiresAt: held.expiresAt }
      : { count: 1, expiresAt: now + windowMs };
    await this.kv.set(KvRateStore.NS, key, next).catch(() => {});
    return next.count;
  }

  /** Drop buckets whose window has passed. @returns {Promise<number>} how many went */
  async sweep(now = Date.now()) {
    const rows = await this.kv.list(KvRateStore.NS).catch(() => []);
    let dropped = 0;
    for (const { key, value } of rows) {
      if (!value || value.expiresAt <= now) {
        await this.kv.delete(KvRateStore.NS, key).catch(() => {});
        dropped++;
      }
    }
    return dropped;
  }
}

/**
 * Decide whether this subject may do another unit of this class of work.
 *
 * FIXED WINDOWS, not a sliding log. A sliding window is fairer at the boundary and costs a
 * list per request to be so; a fixed window's worst case is twice the limit across two
 * adjacent windows, which for limits chosen to bound cost rather than to be precise is a
 * trade worth taking. It also gives an exact `Retry-After`: the window's own end.
 */
export class RateLimiter {
  /**
   * @param {object} deps
   * @param {{bump: (key: string, windowMs: number, now: number) => Promise<number>}} deps.store
   * @param {Record<string, {limit: number, windowMs: number}>} [deps.limits]
   * @param {() => number} [deps.now] injected clock, for tests
   */
  constructor({ store, limits = DEFAULT_RATE_LIMITS, now = () => Date.now() } = {}) {
    if (!store) throw TroveError.invalid('RateLimiter needs a store');
    this.store = store;
    this.limits = limits;
    this.now = now;
  }

  /**
   * @returns {Promise<{ok: boolean, limit?: number, remaining?: number, retryAfterMs?: number}>}
   *   `{ok: true}` for a class with no limit configured — an unnamed class is not an
   *   error, it is work nobody decided to meter.
   */
  async check(subject, className) {
    const rule = this.limits[className];
    if (!rule || !rule.limit) return { ok: true };
    const now = this.now();
    // The bucket is part of the key, so a new window is a new counter and there is nothing
    // to reset — which is also what makes this safe across processes that never talk.
    const bucket = Math.floor(now / rule.windowMs);
    const endsAt = (bucket + 1) * rule.windowMs;
    const count = await this.store.bump(`${className}:${subject}:${bucket}`, rule.windowMs, now);
    if (count > rule.limit) {
      return { ok: false, limit: rule.limit, remaining: 0, retryAfterMs: Math.max(0, endsAt - now) };
    }
    return { ok: true, limit: rule.limit, remaining: rule.limit - count };
  }

  /**
   * The same, as a refusal.
   *
   * QUOTA and retryable, which errors.js already maps to 429 — "A rate limit is 429: back
   * off and try again", as distinct from being out of disk, which is 507 because retrying
   * changes nothing. `retryAfterMs` rides in `details` so the HTTP layer can turn it into
   * a `Retry-After` header instead of every client guessing.
   */
  async enforce(subject, className) {
    const verdict = await this.check(subject, className);
    if (verdict.ok) return verdict;
    throw TroveError.rateLimited(
      `Too many ${className} requests — wait ${Math.ceil(verdict.retryAfterMs / 1000)}s and try again`,
      { details: { limit: verdict.limit, retryAfterMs: verdict.retryAfterMs, kind: className } },
    );
  }
}

/**
 * Who is being limited.
 *
 * The two credentials are already resolved in one place, and a grant is resolved FIRST and
 * an identity only if there is no grant — so this does not re-derive anything, it names
 * what was decided.
 *
 * The third case is the one that needs a decision rather than a default. With no
 * credential there is nothing stable to key on but the address, and an address behind a
 * proxy is whatever the proxy says — trusting a header a client can set is worse than not
 * limiting at all, because it hands every caller their own budget for the asking. So the
 * forwarded address is used only where the operator has said the proxy is trustworthy
 * (TROVE_TRUST_PROXY), and otherwise every anonymous caller shares ONE budget.
 *
 * Sharing one budget is a real limit — it bounds what the drive spends, which is the point
 * — and it has a real cost: on a drive open to the internet, one stranger can exhaust the
 * anonymous allowance for the rest. That is the trade, stated. An operator who does not
 * want it configures a proxy and says so, or requires authentication.
 */
export function rateSubject({ grant, principal, req, trustProxy = false } = {}) {
  if (grant?.keyId) return `key:${grant.keyId}`;
  if (principal?.id) return `user:${principal.id}`;
  if (trustProxy && req) {
    const forwarded = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    if (forwarded) return `ip:${forwarded}`;
  }
  return 'anon';
}

/**
 * What this deployment will actually enforce, in its own words.
 *
 * Exists because the ticket's requirement was that a runtime which cannot enforce a limit
 * says so rather than pretending. `scope: 'isolate'` is that admission: in-memory counters
 * on a runtime with no long-lived process count per isolate, so the effective limit is the
 * configured one times however many isolates the platform decided to run.
 */
export function describeRateLimits({ enabled, store, limits, perProcess }) {
  if (!enabled) return { enabled: false, scope: 'none', limits: {} };
  return {
    enabled: true,
    store,
    scope: store === 'kv' ? 'drive' : (perProcess ? 'process' : 'isolate'),
    limits,
  };
}
