// Reconcile a collection against the bytes actually in its store.
//
// SPIKE. The same work `beginScan` did by hand, as an ngin action — which is
// the interesting comparison, because the hand-rolled version had grown three
// things an action gets for free:
//
//   • a `{ task, alreadyRunning, done }` return shape, invented because a route
//     must answer immediately with something watchable while the work runs on.
//     That is a feed: `started` now, `result` later.
//   • progress reported by poking a TaskRegistry, which clients then poll. That
//     is a feed too — and one an SSE endpoint could subscribe to directly.
//   • a try/finally releasing the claim, which released too early the first
//     time it was written. The container does it, and cannot get it wrong.

import { Action } from '@3sln/ngin';

export class ScanCollection extends Action {
  static deps = ['vfs', 'tasks', 'lifecycle'];

  /**
   * @param {object} opts
   * @param {string} [opts.collectionId]
   * @param {string} [opts.reason]     shown under the task title
   * @param {number|null} [opts.deadlineMs] budget for one slice; null runs to the end
   */
  constructor({ collectionId = 'default', reason = null, deadlineMs = null } = {}) {
    super();
    this.collectionId = collectionId;
    this.reason = reason;
    this.deadlineMs = deadlineMs;
    // Instance deps carry options to the provider — this is how the claim knows
    // which collection it is claiming.
    this.deps = { claim: { collectionId } };
  }

  async execute({ vfs, tasks, lifecycle, claim }, { dispatchFeed, signal }) {
    if (!claim.held) {
      // Someone else is scanning this collection. Say so and stop; this is an
      // ordinary answer, not a failure, so the dispatch completes normally.
      emit(dispatchFeed, 'started', { task: null, alreadyRunning: true });
      return;
    }

    const { task, done } = tasks.begin(
      {
        kind: 'scan',
        title: `Scanning “${this.collectionId}” for outside changes`,
        detail: this.reason,
        unit: 'objects',
        collectionId: this.collectionId,
        cancellable: true,
      },
      (handle) => this.#scan({ vfs, lifecycle, claim, handle, dispatchFeed, signal }),
    );

    // The route is waiting on this: it has the record to answer with long before
    // there is a result to report.
    emit(dispatchFeed, 'started', { task, alreadyRunning: false });
    emit(dispatchFeed, 'result', { result: await done });
  }

  async #scan({ vfs, lifecycle, claim, handle, dispatchFeed, signal }) {
    // A budget, when the caller has one. On Workers a request has a CPU ceiling
    // measured in seconds and a bucket has none at all, so "run until done" is
    // not a thing that can be promised — this runs a slice and remembers where
    // it got to.
    const until = this.deadlineMs ? Date.now() + this.deadlineMs : null;
    const cursor = await claim.readCursor();

    // A scan with no deadline runs for minutes, well past the claim. Renew as it
    // goes, and treat a failed renewal as a stop: something else owns this
    // collection now, and carrying on would put us back in the race the claim
    // exists to prevent.
    let lost = false;
    let renewedAt = Date.now();

    const result = await vfs.scanCollection(this.collectionId, {
      cursor,
      shouldStop: () =>
        lifecycle.closing
        || signal.aborted // the caller gave up — see DispatchFeed.abort
        || handle.cancelled // …or clicked Cancel on the task
        || lost
        || (until != null && Date.now() > until),
      // The store cannot say how many objects it holds without listing them, so
      // this is honestly indeterminate: a count that rises, with no total to
      // divide it by.
      onProgress: ({ scanned, adopted, refreshed }) => {
        handle.progress({
          done: scanned,
          detail: adopted || refreshed ? `${adopted} new, ${refreshed} changed` : null,
        });
        // The same numbers on the feed. Nothing consumes these yet — the task
        // registry is still what /api/tasks reports from — but this is the shape
        // that makes streaming progress possible without a second mechanism.
        emit(dispatchFeed, 'progress', { scanned, adopted, refreshed });
        if (Date.now() - renewedAt < 20_000) return;
        renewedAt = Date.now();
        claim.renew().then((ok) => { if (!ok) lost = true; }).catch(() => {});
      },
    });

    // Record the resume point, or clear it once a pass completes — but only
    // while we still hold the claim. Writing a cursor we no longer own is
    // exactly the clobber the claim is here to stop.
    if (lost || !(await claim.renew())) return { ...result, lostLease: true };
    await claim.writeCursor(result.nextCursor);
    return result;
  }
}

function emit(feed, type, detail) {
  feed.dispatchEvent(Object.assign(new Event(type), detail));
}
