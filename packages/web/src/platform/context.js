// ContextRegistry — the named facts a when-clause is evaluated against.
//
// A REGISTRY of cells, not a bag of values, and the difference is the whole design:
//
//   - Every key is backed by a cell somebody OWNS. The registry never hands the cell out,
//     only its value, so a key can be read by anyone and written by exactly one thing.
//   - A contributor registers while it exists and unregisters when it is disposed, so the
//     set of keys is a fact about what is currently installed rather than a pile that only
//     grows.
//   - Because the backings are cells, a derived layer sits on top for free: a built-in key
//     is a `derive` over the resource it summarises, and so cannot go stale.
//
// That last point is why this replaced a plain map with setters. Context keys are DERIVED
// state — what is selected, what is open, what is focused — and they were maintained by
// pushing: OverlayService wrote `palette.open` as a side effect of opening the palette,
// NavigationService wrote three `editor.*` keys, WorkbenchService four more, ViewportService
// three, and an effect in bl/index.js the explorer's two. Five writers for one derivation,
// and the bug that shape produces is on the record: selecting a file never flipped
// `explorer.hasSelection`, so the Delete keybinding silently did nothing, because only
// NavigateAction had been taught to set it. The fix at the time was to add another writer.
//
// Nothing sets a built-in key now. They are derived — see bl/context.js.

import { cell } from '../runtime.js';
import { evaluateWhen } from './whenclause.js';

/** A cell whose value never changes — for facts about the machine rather than the drive. */
const constant = (value) => ({ onDirty: () => () => {}, getValue: () => value });

export class ContextRegistry {
  #cells = new Map(); // key -> a Cell its owner holds
  #offs = new Map(); // key -> unsubscribe
  #snapshot = cell({});

  constructor(initial = {}) {
    const fixed = {
      platform: navigatorPlatform(),
      isMac: /mac/i.test(navigatorPlatform()),
      ...initial,
    };
    for (const [key, value] of Object.entries(fixed)) this.register(key, constant(value));
  }

  /**
   * Back `key` with a cell. Returns the unregister function.
   *
   * The caller keeps the cell, and that is what makes it the owner: writing means writing
   * something the registry cannot reach. Registering a key twice is refused rather than
   * silently taken over — two owners for one fact is exactly the confusion this shape
   * exists to prevent, so it should be loud.
   *
   * @param {string} key
   * @param {{onDirty: Function, getValue: Function}} source
   * @returns {() => void} unregister
   */
  register(key, source) {
    if (this.#cells.has(key)) {
      throw new Error(`Context key "${key}" already has an owner`);
    }
    this.#cells.set(key, source);
    this.#offs.set(key, source.onDirty(() => this.#changed(key)));
    this.#changed(key); // gaining an owner is itself a change
    return () => this.unregister(key);
  }

  unregister(key) {
    const off = this.#offs.get(key);
    if (!off) return;
    off();
    this.#offs.delete(key);
    this.#cells.delete(key);
    this.#changed(key); // and so is losing one
  }

  #changed() {
    this.#recompute();
  }

  /**
   * Own a key outright: the registry makes the cell and hands back the writer.
   *
   * For the facts that genuinely are pushed rather than derived — a plugin setting its own
   * declared register over RPC. The write capability IS the returned `set`, so holding a
   * reference to the registry is not enough to change anything.
   */
  own(key, initial = undefined) {
    const held = cell(initial);
    const dispose = this.register(key, held);
    return { set: (value) => held.setValue(value), dispose };
  }

  #recompute() {
    const next = {};
    for (const [key, source] of this.#cells) next[key] = source.getValue();
    this.#snapshot.setValue(next);
  }

  /** Every key and its current value. */
  snapshot() {
    return this.#snapshot.getValue();
  }
  get(key) {
    return this.#cells.get(key)?.getValue();
  }
  observe() {
    return this.#snapshot;
  }

  /** True if `whenExpr` holds against the current context. */
  evaluate(whenExpr) {
    return evaluateWhen(whenExpr, this.snapshot());
  }
}

function navigatorPlatform() {
  return typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent || '' : '';
}
