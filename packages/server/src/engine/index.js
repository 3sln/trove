// SPIKE: the scan route, run as an ngin engine.
//
// The point of doing it this way round — engine underneath, `beginScan` on top
// with its signature unchanged — is that the 400-odd existing tests are the
// check. They call `createServer` and drive HTTP; if they still pass, the
// rewrite changed no behaviour. A migration that cannot be verified that way is
// not worth starting.
//
// What one route tells us about forty:
//
//   • Routes stop receiving an 18-key context object and start naming what they
//     use. `ScanCollection` declares `vfs, tasks, lifecycle, claim` and can
//     touch nothing else — which is also how you find out what a route touches
//     without reading it.
//   • Work that must be released is released by the container. The claim's
//     lifetime IS the action's lease.
//   • Progress and results travel one way instead of two. `{ task, done }` and
//     `task.progress()` were both feeds already, hand-rolled.
//   • Cancellation arrives from two directions and both are handled in one
//     place: `signal.aborted` (the caller gave up) and `handle.cancelled` (the
//     user clicked Cancel).

import { Engine } from '@3sln/ngin';
import { providersFor } from './providers.js';
import { ScanCollection } from './actions/scanCollection.js';

export { ScanCollection };

/**
 * Build the engine that owns scanning.
 * @param {{vfs, tasks, kv, shouldClose?: () => boolean}} deps
 */
export function createScanEngine(deps) {
  return new Engine({ providers: providersFor(deps) });
}

/** The shape `beginScan` has always returned, so no caller has to change. */
const NOTHING_SCANNED = {
  scanned: 0, adopted: 0, refreshed: 0, orphaned: 0, skipped: 0,
  failed: 0, unaddressable: 0, stopped: false, nextCursor: null, resumed: false,
};

/**
 * `beginScan(collectionId, opts) -> { task, alreadyRunning, done }`, backed by a
 * dispatch. Identical contract to the hand-written one it replaces.
 *
 * @param {import('@3sln/ngin').Engine} engine
 */
export function scanStarter(engine) {
  return async function beginScan(collectionId = 'default', { reason, deadlineMs = null } = {}) {
    const feed = engine.dispatch(new ScanCollection({ collectionId, reason, deadlineMs }));

    // `started` carries the task record. Awaiting it costs one turn of the event
    // loop and is what lets the route answer with something watchable.
    const started = await feed.next(['started']);
    if (started.alreadyRunning) {
      return { task: null, alreadyRunning: true, done: Promise.resolve({ alreadyRunning: true, ...NOTHING_SCANNED }) };
    }

    // `abort` is named so the wait is not pre-empted by aborting. That rule is
    // for a caller who gave up; this promise is the work's own completion, and
    // an aborted scan still produces a result — a partial one, with
    // `stopped: true` — which is exactly what a resumable scan needs to report.
    const done = feed.next(['result', 'abort']).then((event) => {
      if (event.type === 'result') return event.result;
      // No result means the action never reached the end of a scan: it threw.
      throw event.error ?? event.reason;
    });
    done.catch(() => {});
    return { task: started.task, alreadyRunning: false, done, feed };
  };
}
