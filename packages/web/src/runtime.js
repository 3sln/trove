// Wire the 3sln stack for Trove's web client, exactly as bridle does:
//   - dodo: the default VDOM instance (h, reconcile, element helpers)
//   - bones: reactive "batteries" (watch/Observable/…) built from that instance
//   - fromQuery: bridge an ngin Query subscription into a bones Observable so a
//     Query renders reactively inside a composition via `watch(...)`.

import * as dodo from '@3sln/dodo';
import reactiveFactory from '@3sln/bones/reactive.js';

export const dd = dodo;

export const reactive = reactiveFactory({ dodo });
export const { watch, ObservableSubject, Observable, pipe, map, dedup, zip } = reactive;

/** Adapt an ngin query handle ({ subscribe, peek }) into a bones Observable. */
export function fromQuery(handle) {
  return new Observable((observer) => {
    const sub = handle.subscribe(observer);
    return { unsubscribe: () => sub.unsubscribe() };
  });
}

/** Convenience: dispatch helper bound to an engine. */
export function dispatcher(engine) {
  return (action) => engine.dispatch(action);
}
