// Reactive data services the workbench renders from. These hold *data* state
// (the current collection's items, search results, in-flight transfers) as
// opposed to the shell's UI state (WorkbenchService). ngin Actions mutate them;
// the UI `watch`es them. Each is a plain cell wrapper so the render layer stays
// declarative.

import { cell } from '../runtime.js';

export class ExplorerService {
  constructor(settings) {
    this.settings = settings;
    this.state = {
      items: [], loading: false, error: null,
      selection: [], sort: settings.get('explorer.sort'), order: settings.get('explorer.sortOrder'),
      collectionId: 'default', collections: [], canCreateCollection: false,
      // `stats` is the whole collection; `items` is the page on screen. Keeping both
      // is what lets the UI say "500 of 3,006" instead of quietly claiming 500.
      stats: null, usage: null, nextCursor: null, loadingMore: false, trash: null,
    };
    this.cell = cell(this.state);
  }
  observe() {
    return this.cell;
  }
  set(patch) {
    this.state = { ...this.state, ...patch };
    this.cell.setValue(this.state);
  }
  /**
   * @param {string[]} ids
   * @param {{additive?: boolean, nodes?: object[]}} [opts] `nodes` is the caller's own
   *   copy of what it selected — pass it whenever you have it (see selectedNodes).
   */
  select(ids, { additive = false, nodes = null } = {}) {
    const next = additive ? Array.from(new Set([...this.state.selection, ...ids])) : ids;
    // Selecting what is already selected must not emit. The launcher syncs the
    // highlighted row into here on every mouseenter, and a state push per mouse move
    // would re-render the list under the pointer.
    const same = next.length === this.state.selection.length
      && next.every((id, i) => id === this.state.selection[i]);
    if (same) return;
    this.set({ selection: next, selectionNodes: nodes && !additive ? nodes : null });
  }
  /**
   * The nodes the selection refers to.
   *
   * Resolving ids against `items` only finds rows on the LOADED PAGE of the CURRENT
   * collection — and the launcher's rows come from search (which the server scopes to
   * every readable collection) and from recents (which survive a collection switch).
   * So every row reached by searching resolved to nothing, and rename / move-to-trash /
   * copy-link returned silently while `explorer.hasSelection` said there was a
   * selection. Preferring the nodes the selecting caller already held fixes the whole
   * class; the `items` lookup stays for callers that only have ids.
   */
  selectedNodes() {
    const held = this.state.selectionNodes;
    if (held?.length) return held.filter((n) => this.state.selection.includes(n.id));
    return this.state.items.filter((i) => this.state.selection.includes(i.id));
  }
}

/**
 * API keys, for the admin screen that manages them.
 *
 * Its own service rather than a corner of ExplorerService because it is a different
 * lifetime: keys are read when someone opens Settings and never again, so they should not
 * be part of the state every render of the file list walks over.
 *
 * `minted` holds the one secret a mint returns. It lives here, in memory, and is dropped
 * the moment the admin dismisses it — the server cannot show it again, so the UI is the
 * only place it ever exists, and it should not persist anywhere that outlives the tab.
 */
export class ApiKeysService {
  constructor() {
    this.state = {
      keys: [], loading: false, loaded: false, error: null, minted: null, busy: null,
      // The mint form. Held here rather than in the DOM so the section stays a pure
      // function of state — and so a half-filled form survives a re-render caused by
      // something else on the settings screen.
      draft: null,
    };
    this.cell = cell(this.state);
  }

  /** Open the mint form, empty. */
  startDraft() {
    this.set({ draft: { name: '', expiresInDays: '', caps: {} }, error: null });
  }
  cancelDraft() {
    this.set({ draft: null });
  }
  patchDraft(patch) {
    if (!this.state.draft) return;
    this.set({ draft: { ...this.state.draft, ...patch } });
  }

  /**
   * Toggle one capability on one collection in the draft.
   *
   * `admin` is not treated specially here — it is offered as itself and the server
   * expands it. Pre-ticking read/write/delete when admin is chosen would suggest they
   * are separable afterwards, and they are not.
   */
  toggleCap(collectionId, capability) {
    if (!this.state.draft) return;
    const caps = { ...this.state.draft.caps };
    const held = new Set(caps[collectionId] || []);
    if (held.has(capability)) held.delete(capability);
    else held.add(capability);
    if (held.size) caps[collectionId] = [...held];
    else delete caps[collectionId];
    this.patchDraft({ caps });
  }

  /** The draft as the API wants it, or null when it would grant nothing. */
  draftScopes() {
    const caps = this.state.draft?.caps || {};
    const scopes = Object.entries(caps)
      .filter(([, list]) => list.length)
      .map(([collectionId, capabilities]) => ({ collectionId, capabilities }));
    return scopes.length ? scopes : null;
  }
  observe() {
    return this.cell;
  }
  set(patch) {
    this.state = { ...this.state, ...patch };
    this.cell.setValue(this.state);
  }
  /** Forget the freshly minted secret. Called on dismiss, and after a copy. */
  clearMinted() {
    if (this.state.minted) this.set({ minted: null });
  }
}

export class SearchClientService {
  constructor() {
    this.state = { query: '', mode: 'hybrid', results: [], loading: false, error: null, ran: false, paletteFiles: [], paletteQuery: '', paletteLoading: false, paletteError: null };
    this.cell = cell(this.state);
  }
  observe() {
    return this.cell;
  }
  set(patch) {
    this.state = { ...this.state, ...patch };
    this.cell.setValue(this.state);
  }
}

/**
 * Uploads in flight.
 *
 * This owns the DETAIL an upload needs and a generic task doesn't — bytes moved, an
 * AbortController, per-file retry. It also projects each transfer into ActivityService
 * so the drive has ONE list of "what is happening", covering work on both sides of the
 * wire: an upload running in this browser and a reindex running on the server show up
 * together, because a user doesn't care which machine is busy.
 *
 * The projection is one-way and this stays the owner. Two writable copies of the same
 * fact is how they drift.
 */
export class TransfersService {
  /** @param {import('./activity.js').ActivityService} [activity] */
  constructor(activity = null) {
    this.state = { items: [] }; // { id, name, direction, ratio, loaded, total, status, error }
    this.cell = cell(this.state);
    this._controllers = new Map();
    this.activity = activity;
    this._tasks = new Map(); // transfer id -> activity task handle
  }
  observe() {
    return this.cell;
  }
  #emit() {
    this.cell.setValue(this.state);
  }
  start(id, name, total, controller) {
    this._controllers.set(id, controller);
    this.state = { items: [...this.state.items, { id, name, direction: 'up', ratio: 0, loaded: 0, total, status: 'active', error: null }] };
    this.#emit();
    const task = this.activity?.start({
      kind: 'transfer', title: `Uploading ${name}`, total: total || null, unit: 'bytes',
      onCancel: () => this.cancel(id),
    });
    if (task) this._tasks.set(id, task);
  }
  progress(id, { loaded, total, ratio }) {
    this.state = { items: this.state.items.map((t) => (t.id === id ? { ...t, loaded, total, ratio } : t)) };
    this.#emit();
    this._tasks.get(id)?.progress({ done: loaded, total: total || null });
  }
  finish(id, status = 'done', error = null) {
    this.state = { items: this.state.items.map((t) => (t.id === id ? { ...t, status, error, ratio: status === 'done' ? 1 : t.ratio } : t)) };
    this._controllers.delete(id);
    this.#emit();
    const task = this._tasks.get(id);
    if (task) {
      if (status === 'done') task.succeed();
      else if (status === 'cancelled') task.cancel();
      else task.fail(error || new Error('Upload failed'));
      this._tasks.delete(id);
    }
    if (status === 'done') setTimeout(() => this.dismiss(id), 4000);
  }
  cancel(id) {
    this._controllers.get(id)?.abort();
    this.finish(id, 'cancelled');
  }
  dismiss(id) {
    this.state = { items: this.state.items.filter((t) => t.id !== id) };
    this.#emit();
  }
  clearDone() {
    this.state = { items: this.state.items.filter((t) => t.status === 'active') };
    this.#emit();
  }
}
