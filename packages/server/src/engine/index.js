// The drive as an ngin engine.
//
// `createServer` is a facade over this: it builds the container, obtains the
// backbone, and wires the HTTP surface on top. That layering is what makes the
// migration checkable — every existing test calls `createServer` and drives
// HTTP, so if they still pass, the rewrite changed no behaviour.

import { Engine } from '@3sln/ngin';
import { coreProviders } from './providers/core.js';
import { ScanClaimProvider } from './providers/scan.js';
import {
  NodeAccessProvider, CollectionAccessProvider, UploadAccessProvider,
  SystemNodeProvider, SystemCollectionProvider,
} from './providers/access.js';
import { ScanCollection } from './actions/scanCollection.js';

export { ScanCollection, ScanClaimProvider };
export { buildStorage } from './providers/core.js';

/**
 * Every provider the drive has.
 *
 * @param {object} config the same config object `createServer` takes
 * @param {{closing: boolean}} lifecycleState mutable; `close()` flips it
 */
export function driveProviders(config, lifecycleState) {
  return {
    ...coreProviders(config, lifecycleState),
    claim: ScanClaimProvider,
    // Authorization as something you hold rather than something you checked —
    // see providers/access.js. Denial happens during the lease, so an action
    // that may not act never runs at all.
    node: NodeAccessProvider,
    collection: CollectionAccessProvider,
    upload: UploadAccessProvider,
    // The background domain's grant, named separately so declaring it is a
    // visible decision rather than an option someone passed.
    systemNode: SystemNodeProvider,
    systemCollection: SystemCollectionProvider,
  };
}

/** @returns {Engine} */
export function createDriveEngine(config = {}, lifecycleState = { closing: false }) {
  return new Engine({ providers: driveProviders(config, lifecycleState) });
}

/** The names `createServer` hands back, and therefore obtains up front. */
export const BACKBONE = [
  'storage', 'sqlite', 'metadata', 'kv', 'tasks', 'issues', 'notifications',
  'sidecar', 'collections', 'identity', 'auth', 'search', 'vfs', 'plugins',
  'apiKeys', 'capabilities', 'rotation', 'lifecycle', 'storageCheck',
];

/** The shape `beginScan` has always returned, so no caller has to change. */
const NOTHING_SCANNED = {
  scanned: 0, adopted: 0, refreshed: 0, orphaned: 0, skipped: 0,
  failed: 0, unaddressable: 0, stopped: false, nextCursor: null, resumed: false,
};

/**
 * `beginScan(collectionId, opts) -> { task, alreadyRunning, done, feed }`,
 * backed by a dispatch.
 *
 * @param {Engine} engine
 */
export function scanStarter(engine) {
  return async function beginScan(collectionId = 'default', { reason, deadlineMs = null } = {}) {
    const feed = engine.dispatch(new ScanCollection({ collectionId, reason, deadlineMs }));

    // `started` carries the task record. Awaiting it costs one turn of the event
    // loop and is what lets the route answer with something watchable.
    const started = await feed.next(['started']);
    if (started.alreadyRunning) {
      return {
        task: null,
        alreadyRunning: true,
        done: Promise.resolve({ alreadyRunning: true, ...NOTHING_SCANNED }),
        feed,
      };
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
