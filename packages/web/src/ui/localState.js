// State a component owns, that still has to reach the render.
//
// Some UI state belongs to one component and nothing else: which keybinding is mid-capture,
// what has been typed into a dialog that has not been submitted, which capabilities are
// ticked in a plugin review. It is not drive state, so it has no business in a service, and
// it is thrown away the moment the dialog closes.
//
// It used to be a module-level `let` that components mutated in place, plus a `rerender()`
// hook threaded through fourteen modules so the leaf that changed it could poke the root
// into redrawing. That inverted the whole point of the reactive layer: data flowed down and
// invalidation travelled back up out of band, through a function passed as an argument.
//
// So it lives in a cell instead. A component writes; the cell invalidates; the derived
// snapshot recomputes; the render happens for the same reason every other render happens.
// Nothing has to be told.
//
// Keyed by name rather than split into a cell per component, so the composition has one
// more input rather than one per dialog — and so the next component with a scrap of local
// state has an obvious place to put it rather than a reason to reach for a `let`.

import { cell } from '../runtime.js';

const state = cell({});

export const localState = {
  /** The cell, for the composition's snapshot. */
  observe: () => state,

  /** @param {string} key */
  get(key) {
    return state.getValue()[key];
  },

  /**
   * Replace one component's slice.
   *
   * A new object every time, because a cell compares with Object.is and drops a write of
   * what it already holds — mutating in place and writing the same reference is exactly
   * the "nothing changed" that the old `rerender` had to work around.
   */
  set(key, value) {
    state.setValue({ ...state.getValue(), [key]: value });
  },

  /** Merge into one component's slice, for the common patch-a-field case. */
  patch(key, fields) {
    this.set(key, { ...(state.getValue()[key] || {}), ...fields });
  },
};
