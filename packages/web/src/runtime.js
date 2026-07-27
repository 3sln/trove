// Wire the 3sln stack for Trove's web client.
//
//   - dodo: the VDOM (h, reconcile, element helpers, alias/special)
//   - dodo/reactive: cells, and the `watch` component that renders one
//
// bones is gone; what Trove used of it — `watch`, a writable subject, and a way
// to combine several of them — moved into dodo as the **Cell** protocol:
//
//   { onDirty(fn) -> unsubscribe, getValue() -> any }
//
// That is a smaller contract than the observable it replaces, and the difference
// shows up in two places we care about. It is push-to-invalidate / pull-to-read,
// so any number of invalidations in one frame coalesce into a single render;
// and a cell always HAS a value, so a `watch` renders its store's current state
// on the first pass instead of waiting for an emission that already happened.
//
// `PENDING` is how a cell says "no value yet" — `watch` renders its placeholder
// instead of calling the builder. An error is reported by THROWING from
// `getValue()`, which `watch` renders as its error view. Both matter for
// `fromAsync` below, which is the only shape of ours the module does not ship.

import * as dodo from '@3sln/dodo';
import {
  watch, cell, derive, constant, mapCell, connectable,
  fromObservable, toObservable, effect, isCell, readCell, PENDING,
} from '@3sln/dodo/reactive';

export const dd = dodo;

export {
  watch, cell, derive, constant, mapCell, connectable,
  fromObservable, toObservable, effect, isCell, readCell, PENDING,
};

/**
 * A cell backed by one async call: `PENDING` until it settles, the value after,
 * and a throw from `getValue()` if it rejects — which is exactly the vocabulary
 * `watch`'s `placeholder` and `error` options are written against.
 *
 * The work starts on the first listener, not at construction, so building one
 * for a view that is never rendered costs nothing. It runs ONCE: a cell that
 * refetched every time its last watcher went away and came back would reload a
 * document on every remount.
 */
export function fromAsync(work) {
  let state = { status: 'idle' };
  return connectable(
    (notify) => {
      if (state.status === 'idle') {
        state = { status: 'running' };
        Promise.resolve()
          .then(work)
          .then(
            (value) => { state = { status: 'done', value }; notify(); },
            (error) => { state = { status: 'failed', error }; notify(); },
          );
      }
      // Nothing to disconnect: a promise cannot be un-awaited, and the result is
      // kept so a later listener reads it rather than starting again.
      return () => {};
    },
    () => {
      if (state.status === 'failed') throw state.error;
      return state.status === 'done' ? state.value : PENDING;
    },
  );
}

/** The reactive API as one object, for `platform.reactive` (and plugin-facing code). */
export const reactive = {
  watch, cell, derive, constant, mapCell, connectable,
  fromObservable, fromAsync, toObservable, effect, isCell, readCell, PENDING,
};
