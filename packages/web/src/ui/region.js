// A region: one part of the shell, subscribed to only the queries it reads.
//
// The workbench is a single `watch` over a `derive` of eighteen cells, so any change to any
// of them rebuilds the whole VDOM — activity bar, status bar, every overlay, the file list.
// dodo reconciles, so the DOM update stays small; the REBUILD does not. An upload progress
// tick reconstructs all 500 rows of a file list to move one number in the transfer tray.
//
// A region fixes that by narrowing the subscription instead of the render: it watches the
// queries it actually reads, and a change to anything else never reaches it. That also makes
// the dependency legible — the region's queries are its argument list, rather than something
// you infer by reading which snapshot keys the body touches.
//
// The teardown matters as much as the render. A region that leaves the tree drops its
// watchers; dodo disconnects the cells; ngin kills the query realizations, releasing their
// leases and whatever they held open. That is what makes a query the right home for
// something like a minted media URL — alive while a region is looking at it, gone when it
// stops — with no component writing cleanup.
//
// See docs/tickets/009.

import { dd, watch, derive } from '../runtime.js';
import { watchQuery } from '../bl/watchQuery.js';

/**
 * @param {object} engine
 * @param {Record<string, object>} queries name → SHARED query instance (see bl/queries.js)
 * @param {(state: Record<string, any>) => any} build the region's view; close over `ui`
 * @param {{placeholder?: () => any, error?: (err: Error) => any}} [opts]
 * @returns {() => any} a component, built ONCE — see below for why that matters
 */
export function region(engine, queries, build, opts) {
  const names = Object.keys(queries);
  // Resolved at composition, not per render. `watchQuery` caches per (engine, query) so
  // these would be the same cells either way, but doing it here says the subscription
  // belongs to the region rather than being re-established on every pass.
  const cells = names.map((name) => watchQuery(engine, queries[name]));
  // `derive` coalesces: several of these changing in one frame still costs one render.
  const combined = derive(cells, (...values) =>
    Object.fromEntries(names.map((name, i) => [name, values[i]])));

  // ONE alias function, and one options object, for the life of the app.
  //
  // dodo identifies an alias by the FUNCTION: "swapping the alias function ... is a
  // different component, and reusing the state would skip the old one's detach and the new
  // one's attach". So `alias(...)` built inside the render would detach and re-attach the
  // watch — dropping the subscription, killing the query realization and booting a fresh
  // one — on every pass of the parent. That is the precise opposite of what a region is
  // for, and it would have looked like it worked.
  //
  // `build` and `opts` are hoisted for the same reason one level down: `watch` compares its
  // arguments, and a builder closure rebuilt per render is a new argument every time.
  return dd.alias(() => watch(combined, build, opts));
}
