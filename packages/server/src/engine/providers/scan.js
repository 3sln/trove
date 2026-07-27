// The scan's dependencies, as ngin providers.
//
// The one provider here that is not part of the drive's backbone: a claim is
// obtained per scan, not once per process. Its lifetime is exactly an action's
// lease — taken before the work, given back after, given back even if the work
// throws — which is `Provider.obtain`/`release` verbatim, and replaces a
// hand-rolled try/finally that had already gone wrong once by releasing early.

import { Provider } from '@3sln/ngin';

/** Namespace for both the resume cursor and the claim on a collection. */
export const SCAN_NS = 'scan-cursor';
/**
 * How long a claim stays valid unrenewed. Long enough that a slow list() does
 * not lose it, short enough that a holder that died — an isolate evicted, a
 * container killed — does not block the collection for long.
 */
export const LEASE_MS = 60_000;

/**
 * The right to scan one collection.
 *
 * A scan writes a resume cursor, so two running at once means last-writer-wins
 * on that cursor and a slice of the bucket is silently never reached. The guard
 * has to live where every process can see it, which is why this is a lease in
 * the metadata store rather than a flag in memory.
 *
 * `obtain` does NOT throw when the claim is taken. Another scan already running
 * is an ordinary answer to "may I scan this", not an exception — and a resource
 * that reports `held: false` keeps the release path identical either way.
 */
export class ScanClaimProvider extends Provider {
  static deps = ['kv'];

  constructor({ kv }) {
    super();
    this.kv = kv;
  }

  async obtain({ collectionId = 'default', ttlMs = LEASE_MS } = {}) {
    // Held for the claim's lifetime, not just this call: renewing and releasing
    // both need it, and they happen after `obtain` has returned.
    const kv = await this.kv.obtain();
    const token = await kv.acquire(SCAN_NS, collectionId, ttlMs);
    return {
      collectionId,
      held: !!token,
      _kv: kv,
      _token: token,
      /** False means the claim was lost — stop, something else owns this now. */
      renew: () => (token ? kv.renew(SCAN_NS, collectionId, token, ttlMs) : Promise.resolve(false)),
      readCursor: async () => (token ? (await kv.get(SCAN_NS, collectionId))?.cursor || null : null),
      writeCursor: (cursor) =>
        (cursor
          ? kv.set(SCAN_NS, collectionId, { cursor, at: Date.now() })
          : kv.delete(SCAN_NS, collectionId).catch(() => {})),
    };
  }

  async release(claim) {
    if (!claim) return;
    if (claim._token) {
      await claim._kv.release(SCAN_NS, claim.collectionId, claim._token).catch(() => {});
    }
    this.kv.release(claim._kv);
  }
}
