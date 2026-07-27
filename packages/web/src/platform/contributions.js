// ContributionRegistry — ONE map of `uri -> contribution`, where every contribution
// carries its own `type` and that type's options.
//
// There used to be a separate collection per kind (commands, openers, statusItems…),
// which meant a name could mean different things in different collections and nothing
// tied a contribution back to a verifiable owner. Now there is a single address space:
//
//   trove+contrib:acme.com/docs/pdfViewer   { type: 'opener',     match, entry }
//   trove+contrib:acme.com/docs/status      { type: 'statusItem', slot, render }
//   trove+contrib:acme.com/docs/busy        { type: 'register',   default }
//   trove+contrib:acme.com/docs/keys        { type: 'keymap',     bindings }
//   trove+contrib:core/workbench/…          built-ins, reserved `core` domain
//
// So a plugin's opener, status slot, register and command may all be called "status"
// without colliding — with each other, or with another plugin's.
//
// Contribution types (see @trove/core/plugins/contributions.js for the manifest form):
//   command     { title, category?, icon?, when?, offline?, palette? }
//   opener      { title, match:{ext,mime}, entry, priority?, offline?, dock? }
//   indexer     { title, match, entry }            (declared here; the SERVER runs it)
//   statusItem  { slot:'left'|'right', render:'html', order?, when?, offline? }
//   register    { default?, description? }         (a context value slot)
//   keymap      { bindings:[{key, command, when?, args?}] }

import { cell, derive } from '../runtime.js';
import { selectorMatches } from '@trove/core/util.js';
import { parseContribUri, coreUri, CONTRIB_SCHEME } from '@trove/core/plugins/identity.js';
import { CONTRIBUTION_TYPES } from '@trove/core/plugins/contributions.js';

export { CONTRIBUTION_TYPES };

/**
 * Address normalization — the one rule: a bare name belongs to the host's reserved
 * `core` domain, anything from a plugin is always fully qualified. So the workbench
 * keeps saying `exec('explorer.delete')` while every contribution still has a real,
 * unambiguous URI (`trove+contrib:core/workbench/explorer.delete`).
 */
export function toUri(nameOrUri) {
  return String(nameOrUri).startsWith(CONTRIB_SCHEME) ? nameOrUri : coreUri(nameOrUri);
}

export class ContributionRegistry {
  constructor() {
    this.items = new Map(); // uri -> { uri, type, id, name, pluginId, ...options }
    this.cell = cell([]);
    this.byType = new Map(); // type -> derived cell (lazily created)
  }

  #emit() {
    this.cell.setValue([...this.items.values()]);
  }

  /**
   * Register one contribution at its URI. Returns a dispose fn.
   * @param {string} nameOrUri  a bare core name, or trove+contrib:<domain>/<plugin>/<name>
   * @param {{type: string}} contribution
   */
  register(nameOrUri, contribution) {
    const type = contribution?.type;
    if (!CONTRIBUTION_TYPES.includes(type)) {
      throw new Error(`Unknown contribution type "${type}" for ${nameOrUri}`);
    }
    const uri = toUri(nameOrUri);
    const parsed = parseContribUri(uri);
    if (!parsed) throw new Error(`Not a contribution URI: ${uri}`);
    const entry = {
      ...contribution, uri, type,
      // `id` is the short name the workbench uses to address it (bare for built-ins,
      // the URI for plugin contributions, which are only ever addressed fully).
      id: parsed.domain === 'core' ? parsed.name : uri,
      name: parsed.name,
      pluginId: contribution.pluginId ?? (parsed.domain === 'core' ? null : parsed.pluginId),
    };
    this.items.set(uri, entry);
    this.#emit();
    return () => this.unregister(uri);
  }

  /** Merge new options into an existing contribution (a plugin driving its own slot). */
  update(nameOrUri, patch) {
    const uri = toUri(nameOrUri);
    const cur = this.items.get(uri);
    if (!cur) return false;
    this.items.set(uri, { ...cur, ...patch });
    this.#emit();
    return true;
  }

  unregister(nameOrUri) {
    if (this.items.delete(toUri(nameOrUri))) this.#emit();
  }
  /** Drop everything a plugin contributed (uninstall / reload). */
  unregisterPlugin(pluginId) {
    let changed = false;
    for (const [uri, c] of this.items) if (c.pluginId === pluginId) { this.items.delete(uri); changed = true; }
    if (changed) this.#emit();
  }

  get(nameOrUri) {
    return nameOrUri ? this.items.get(toUri(nameOrUri)) || null : null;
  }
  all() {
    return [...this.items.values()];
  }
  ofType(type) {
    return this.all().filter((c) => c.type === type);
  }
  /** One plugin's contributions, optionally of a single type. */
  ofPlugin(pluginId, type) {
    return this.all().filter((c) => c.pluginId === pluginId && (!type || c.type === type));
  }
  observe() {
    return this.cell;
  }
  /**
   * A reactive view of one type (status items, openers, …).
   *
   * Derived rather than a second subject fanned out to by hand: `derive` recomputes
   * from the one list, and a watcher of the result is only re-rendered when its own
   * slice actually differs — so registering an opener no longer redraws the status bar.
   */
  observeType(type) {
    let view = this.byType.get(type);
    if (!view) {
      view = derive([this.cell], (all) => all.filter((c) => c.type === type));
      this.byType.set(type, view);
    }
    return view;
  }

  // --- typed lookups ---------------------------------------------------------

  /** Every opener whose selector matches `node`, best (highest priority) first. */
  openersFor(node) {
    return this.ofType('opener')
      .filter((o) => selectorMatches(o.match, node))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  /** Pick the best opener for a node, honouring `when` and availability. */
  openerFor(node, evaluate, isAvailable) {
    return this.openersFor(node)
      .find((o) => (!o.when || evaluate(o.when)) && (!isAvailable || isAvailable(o))) || null;
  }

  /** Every keybinding from every registered keymap, in registration order. */
  keybindings() {
    return this.ofType('keymap').flatMap((k) =>
      (k.bindings || []).map((b) => ({ ...b, keymap: k.uri, pluginId: k.pluginId })));
  }
}
