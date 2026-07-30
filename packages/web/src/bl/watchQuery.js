// Reading an engine query from the render layer.
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

import { fromObservable } from '../runtime.js';

/**
 * Cache the bridged cell per (engine, query instance).
 *
 * Two components watching the same query must land on the same cell, or each gets its own
 * subscription and dodo connects the underlying query twice. ngin already shares the
 * realization by instance identity; this keeps the layer above from undoing that.
 *
 * Weak on the engine so a disposed engine takes its cells with it, and weak on the query so
 * a memoised parameterised query that falls out of use does too.
 */
const cells = new WeakMap();

/**
 * @param {object} engine
 * @param {object} queryInstance a SHARED instance — see bl/queries.js on why never a fresh one
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
    cell = fromObservable(engine.query(queryInstance));
    forEngine.set(queryInstance, cell);
  }
  return cell;
}
