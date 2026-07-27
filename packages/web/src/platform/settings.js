// SettingsService — schema-driven, persisted, reactive settings (VS Code's
// settings model). Core and plugins register typed setting schemas; values are
// stored in localStorage, namespaced, and merged over defaults. The Settings UI
// is generated from the schema, so adding a setting never means touching UI code.
// Plugin keys are namespaced under the plugin id.

import { cell } from '../runtime.js';

const STORAGE_KEY = 'trove.settings';

export class SettingsService {
  constructor() {
    this.schema = new Map(); // key -> { type, default, title, description, enum?, minimum?, maximum?, category, order }
    this.values = read();
    this.cell = cell(this.effective());
  }

  /**
   * Register one or more settings. Each: { key, type, default, title,
   * description?, enum?, enumLabels?, minimum?, maximum?, category?, order? }
   */
  register(schemas) {
    for (const s of [].concat(schemas)) this.schema.set(s.key, s);
    this.cell.setValue(this.effective());
    return () => {
      for (const s of [].concat(schemas)) this.schema.delete(s.key);
      this.cell.setValue(this.effective());
    };
  }

  get(key) {
    if (key in this.values) return this.values[key];
    return this.schema.get(key)?.default;
  }

  set(key, value) {
    const schema = this.schema.get(key);
    if (schema && value === schema.default) delete this.values[key];
    else this.values[key] = value;
    write(this.values);
    this.cell.setValue(this.effective());
  }

  reset(key) {
    delete this.values[key];
    write(this.values);
    this.cell.setValue(this.effective());
  }

  /** Full resolved values (defaults ⊕ overrides). */
  effective() {
    const out = {};
    for (const [key, s] of this.schema) out[key] = key in this.values ? this.values[key] : s.default;
    // Include stored keys with no (current) schema, so unknown/plugin values survive.
    for (const [key, v] of Object.entries(this.values)) if (!(key in out)) out[key] = v;
    return out;
  }

  observe() {
    return this.cell;
  }

  /** Schema entries grouped by category, for the Settings UI. */
  grouped() {
    const groups = new Map();
    for (const s of [...this.schema.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      // `hidden` settings are state the app keeps under the settings key, not choices a
      // person makes — the opener associations, for one, which are edited through the
      // opener chooser and have their own section below. Rendering them anyway put a row
      // reading "[object Object]" at the top of Settings.
      if (s.hidden) continue;
      const cat = s.category || 'General';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push({ ...s, value: this.get(s.key) });
    }
    return [...groups.entries()].map(([category, items]) => ({ category, items }));
  }

  scopedFor(pluginId) {
    const prefix = `${pluginId}.`;
    return {
      register: (schemas) =>
        this.register([].concat(schemas).map((s) => ({ ...s, key: prefix + s.key, category: s.category || pluginId }))),
      get: (key) => this.get(prefix + key),
      set: (key, value) => this.set(prefix + key, value),
    };
  }
}

function read() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}
function write(values) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch { /* quota / private mode */ }
}
