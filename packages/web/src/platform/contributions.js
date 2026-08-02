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
// Contribution types (see @3sln/trove/core/plugins/contributions.js for the manifest form):
//   command     { title, category?, icon?, when?, offline?, palette? }
//   opener      { title, match:{ext,mime}, entry, priority?, offline?, dock? }
//   indexer     { title, match, entry }            (declared here; the SERVER runs it)
//   statusItem  { slot:'left'|'right', render:'html', order?, when?, offline? }
//   register    { default?, description? }         (a context value slot)
//   keymap      { bindings:[{key, command, when?, args?}] }
//   view        { title, icon?, match?, priority?, render, move? }

import { cell } from '../runtime.js';
import { selectorMatches } from '@3sln/trove/core/util.js';
import { parseContribUri, coreUri, CONTRIB_SCHEME } from '@3sln/trove/core/plugins/identity.js';
import { CONTRIBUTION_TYPES as PACKAGE_TYPES } from '@3sln/trove/core/plugins/contributions.js';

// Everything a package can declare, plus the workbench's own. `view` — how a list of
// results is drawn — is the second kind: it is not part of the package format, so core
// (which is where the manifest is parsed) has no reason to know the word.
export const CONTRIBUTION_TYPES = [...PACKAGE_TYPES, 'view'];

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
    const pluginId = contribution.pluginId ?? (parsed.domain === 'core' ? null : parsed.pluginId);
    const entry = {
      ...contribution, uri, type,
      // `id` is the short name the workbench uses to address it (bare for built-ins,
      // the URI for plugin contributions, which are only ever addressed fully).
      id: parsed.domain === 'core' ? parsed.name : uri,
      name: parsed.name,
      pluginId,
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
  get(nameOrUri) {
    return nameOrUri ? this.items.get(toUri(nameOrUri)) || null : null;
  }
  all() {
    return [...this.items.values()];
  }
  ofType(type) {
    return this.all().filter((c) => c.type === type);
  }
  observe() {
    return this.cell;
  }
  // --- typed lookups ---------------------------------------------------------

  /** Every opener whose selector matches `node`, best (highest priority) first. */
  openersFor(node) {
    return this.ofType('opener')
      .filter((o) => selectorMatches(o.match, node))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  /** Every keybinding from every registered keymap, in registration order. */
  keybindings() {
    return this.ofType('keymap').flatMap((k) =>
      (k.bindings || []).map((b) => ({ ...b, keymap: k.uri, pluginId: k.pluginId })));
  }
}
