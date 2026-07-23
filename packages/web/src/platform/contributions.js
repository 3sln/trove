// ContributionRegistry — the single place every extensible surface is declared,
// modeled on VS Code's contribution points. Core features and plugins register
// into the same registry, so a built-in opener and a plugin opener are
// indistinguishable to the workbench. Each collection is reactive (an
// ObservableSubject of its current items) so views re-render when contributions
// come and go — e.g. a plugin activating adds its command to the palette live.
//
// Contribution points:
//   commands     { id, title, category?, icon?, when?, palette?, handler? }
//   keybindings  { key, command, when?, args? }
//   menus        { menu, command?, group?, order?, when?, submenu? }   (menu = location id)
//   views        { id, title, icon, order?, when?, component }         (activity-bar containers)
//   openers      { id, title, selector, priority?, component?, pluginId? }
//   indexers     { id, title, pluginId? }
//   statusItems  { id, align?, priority?, text, tooltip?, command?, when? }

import { ObservableSubject } from '../runtime.js';

class Collection {
  constructor(name) {
    this.name = name;
    this.items = new Map(); // id -> item
    this.subject = new ObservableSubject([]);
    this.seq = 0;
  }
  #emit() {
    this.subject.next([...this.items.values()]);
  }
  register(item, idKey = 'id') {
    const id = item[idKey] ?? `${this.name}-${++this.seq}`;
    const entry = { ...item, [idKey]: id };
    this.items.set(id, entry);
    this.#emit();
    return () => {
      this.items.delete(id);
      this.#emit();
    };
  }
  get(id) {
    return this.items.get(id);
  }
  all() {
    return [...this.items.values()];
  }
  observe() {
    return this.subject;
  }
}

export class ContributionRegistry {
  constructor() {
    this.commands = new Collection('command');
    this.keybindings = new Collection('keybinding');
    this.menus = new Collection('menu');
    this.views = new Collection('view');
    this.openers = new Collection('opener');
    this.indexers = new Collection('indexer');
    this.statusItems = new Collection('statusItem');
  }

  // Menus are queried by location a lot; index them for O(items-in-menu).
  menusFor(menuId, evaluate) {
    return this.menus
      .all()
      .filter((m) => m.menu === menuId && (!m.when || evaluate(m.when)))
      .sort((a, b) => (a.group || '').localeCompare(b.group || '') || (a.order ?? 0) - (b.order ?? 0));
  }

  /**
   * Pick the best opener for a node. Openers declare a selector; the highest
   * priority match wins. Returns the opener contribution or null.
   */
  openerFor(node, evaluate) {
    const candidates = this.openers
      .all()
      .filter((o) => matchesSelector(o.selector, node) && (!o.when || evaluate(o.when)))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return candidates[0] || null;
  }
  openersFor(node) {
    return this.openers.all().filter((o) => matchesSelector(o.selector, node));
  }
}

function matchesSelector(selector, node) {
  if (!selector || node?.kind !== 'file') return false;
  if (selector.match) {
    try {
      if (selector.match(node)) return true;
    } catch { /* ignore */ }
  }
  const name = (node.name || '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  if (selector.ext?.some((e) => e.toLowerCase() === ext)) return true;
  const mime = node.contentType || '';
  if (selector.mime?.some((m) => (m.endsWith('/*') ? mime.startsWith(m.slice(0, -1)) : mime === m))) return true;
  return false;
}

export { matchesSelector };
