// ContextKeyService — the reactive bag of boolean/string/number flags that
// describe the workbench's current state (which view is focused, whether a file
// is open, its type, whether the palette is showing…). when-clauses evaluate
// against it, so commands/keybindings/menus light up and dim as state changes.
//
// It's a single cell of the whole context object, so any consumer can `watch` it and
// re-render, and keybinding resolution reads a plain snapshot.
// Plugins get a *scoped* setter (keys they set are namespaced under their id) so
// they can drive their own when-clauses without stomping core keys.

import { cell } from '../runtime.js';
import { evaluateWhen } from './whenclause.js';

export class ContextKeyService {
  constructor(initial = {}) {
    this.state = {
      platform: navigatorPlatform(),
      isMac: /mac/i.test(navigatorPlatform()),
      ...initial,
    };
    this.cell = cell(this.state);
  }

  get(key) {
    return this.state[key];
  }
  snapshot() {
    return this.state;
  }
  observe() {
    return this.cell;
  }

  set(key, value) {
    if (this.state[key] === value) return;
    this.state = { ...this.state, [key]: value };
    this.cell.setValue(this.state);
  }
  setMany(obj) {
    let changed = false;
    const next = { ...this.state };
    for (const [k, v] of Object.entries(obj)) {
      if (next[k] !== v) {
        next[k] = v;
        changed = true;
      }
    }
    if (changed) {
      this.state = next;
      this.cell.setValue(next);
    }
  }
  remove(key) {
    if (!(key in this.state)) return;
    const { [key]: _drop, ...rest } = this.state;
    this.state = rest;
    this.cell.setValue(rest);
  }

  /** True if `whenExpr` holds against the current context. */
  evaluate(whenExpr) {
    return evaluateWhen(whenExpr, this.state);
  }

  /** A setter namespaced under a plugin id, so plugin keys can't collide. */
  scopedFor(pluginId) {
    const prefix = `${pluginId}.`;
    return {
      set: (key, value) => this.set(prefix + key, value),
      remove: (key) => this.remove(prefix + key),
    };
  }
}

function navigatorPlatform() {
  return typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent || '' : '';
}
