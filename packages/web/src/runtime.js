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
// `getValue()`, which `watch` renders as its error view.

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

/** The reactive API as one object, for `platform.reactive` (and plugin-facing code). */
export const reactive = {
  watch, cell, derive, constant, mapCell, connectable,
  fromObservable, toObservable, effect, isCell, readCell, PENDING,
};
