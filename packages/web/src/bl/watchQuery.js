// Reading an engine query from the render layer.
//
// Mostly this exists to be the ONE place that knows how a query reaches a component. The
// bridging itself is a single call; the value is that it is not re-derived at fifteen call
// sites, and that if it ever needs an initial value or an error view, there is somewhere to
// put it.
//
// `engine.query(q)` answers an observable — `subscribe({next, error, complete})` — and dodo's
// `watch` takes a Cell — `onDirty(fn)` plus `getValue()`. `fromObservable` already bridges
// exactly those two shapes, so this is thin on purpose: the point is that there is ONE place
// that knows how a query reaches a component, rather than the adapter being re-derived at
// every call site.
//
// The subscription belongs to the CELL, not to the component: dodo connects a cell when its
// first watcher attaches and disconnects when the last one leaves, which is the same
// lifetime ngin gives a query realization. So a region that scrolls out of the tree stops
// observing, the query's `kill` runs, and whatever it was holding is released — without any
// component writing teardown.
//
// See docs/tickets/009.

import { fromObservable, PENDING } from '../runtime.js';

/**
 * Cache the bridged cell per (engine, query instance).
 *
 * Not, as this first claimed, because two cells would "undo ngin's sharing" — they would
 * not. Measured: two independent `fromObservable(engine.query(q))` over one instance boot
 * the query ONCE and kill it once, because ngin shares the realization by instance and does
 * not care how many observers arrive or through what. The sharing was never at risk.
 *
 * What the cache actually buys is smaller and worth stating accurately:
 *
 *   - **Idempotence.** `watchQuery` can be called freely and returns the same cell, so it
 *     is safe in a render. Without it, `watch` — which compares its source by identity and
 *     resubscribes when it changes — would tear down and re-establish every pass.
 *   - **One fan-out per change** instead of one per bridge. Each extra cell is another
 *     observer on the controller and another invalidation to propagate.
 *
 * Neither is correctness, so this is an optimisation and a convenience, not a safeguard.
 * The safeguard against duplicate realizations is interning the query instance — see
 * bl/intern.js, which is where that problem is actually solved.
 *
 * Weak on the engine so a disposed engine takes its cells with it, and weak on the query so
 * an interned instance that falls out of use does too.
 */
const cells = new WeakMap();

/**
 * @param {object} engine
 * @param {object} queryInstance an INTERNED instance — see bl/intern.js
 * @returns {object} a dodo Cell, PENDING until the query produces its first value
 */
export function watchQuery(engine, queryInstance) {
  let forEngine = cells.get(engine);
  if (!forEngine) {
    forEngine = new WeakMap();
    cells.set(engine, forEngine);
  }
  let cell = forEngine.get(queryInstance);
  if (!cell) {
    // A query may declare what it means before it knows — `initial = null` for something
    // fetched over the network, say. Without one the cell is PENDING, and PENDING reaching
    // a `watch` renders its placeholder: fine for a region that can show an empty bar for a
    // frame, wrong for a snapshot feeding the whole shell, which would blank until the
    // request came back. The initial belongs to the query rather than to this call, so it
    // cannot differ between two call sites reading the same thing.
    const initial = 'initial' in queryInstance ? queryInstance.initial : PENDING;
    cell = fromObservable(engine.query(queryInstance), { initial });
    forEngine.set(queryInstance, cell);
  }
  return cell;
}
