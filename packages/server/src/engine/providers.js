// The scan's dependencies, as ngin providers.
//
// SPIKE. One route's worth, to find out whether the backend reads better as an
// engine before forty of them are rewritten. See engine/README.md.
//
// Two shapes are here on purpose:
//
//   • Things `createServer` already built (vfs, tasks, kv) are wrapped as
//     singletons. That is what the first step of a real migration looks like —
//     the graph moves under the container one piece at a time, and nothing has
//     to be rebuilt to start.
//   • The scan CLAIM is a real provider, because it is the piece that shows why
//     a container is worth having. Its lifetime is exactly a lease: obtained
//     before the work, released after, released even if the work throws. That
//     is `Provider.obtain`/`release` verbatim, and it replaces a hand-rolled
//     try/finally that had already gone wrong once by releasing too early.

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

/**
 * Wrap what the server already assembled. The endgame is for each of these to
 * construct its own resource — that is where the container starts paying for
 * teardown order and lazy init — but nothing about the layers above depends on
 * which it is, which is the property that makes the migration incremental.
 */
export function providersFor({ vfs, tasks, kv, shouldClose = () => false }) {
  return {
    vfs: Provider.fromSingleton(vfs),
    tasks: Provider.fromSingleton(tasks),
    kv: Provider.fromSingleton(kv),
    // Shutdown, as a dependency rather than a captured closure variable. An
    // action that must stop when the server is going down should have to say so.
    lifecycle: Provider.fromSingleton({ get closing() { return shouldClose(); } }),
    claim: ScanClaimProvider,
  };
}
