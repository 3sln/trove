// Reactive data services the workbench renders from. These hold *data* state
// (the current collection's items, search results, in-flight transfers) as
// opposed to the shell's UI state (WorkbenchService). ngin Actions mutate them;
// the UI `watch`es them. Each is a plain ObservableSubject wrapper so the render
// layer stays declarative.

import { ObservableSubject } from '../runtime.js';

export class ExplorerService {
  constructor(settings) {
    this.settings = settings;
    this.state = {
      items: [], loading: false, error: null,
      selection: [], sort: settings.get('explorer.sort'), order: settings.get('explorer.sortOrder'),
      collectionId: 'default', collections: [], canCreateCollection: false,
      // `stats` is the whole collection; `items` is the page on screen. Keeping both
      // is what lets the UI say "500 of 3,006" instead of quietly claiming 500.
      stats: null, nextCursor: null, loadingMore: false,
    };
    this.subject = new ObservableSubject(this.state);
  }
  observe() {
    return this.subject;
  }
  set(patch) {
    this.state = { ...this.state, ...patch };
    this.subject.next(this.state);
  }
  select(ids, { additive = false } = {}) {
    const next = additive ? Array.from(new Set([...this.state.selection, ...ids])) : ids;
    this.set({ selection: next });
  }
  selectedNodes() {
    return this.state.items.filter((i) => this.state.selection.includes(i.id));
  }
}

export class SearchClientService {
  constructor() {
    this.state = { query: '', mode: 'hybrid', results: [], loading: false, error: null, ran: false, paletteFiles: [], paletteQuery: '', paletteLoading: false, paletteError: null };
    this.subject = new ObservableSubject(this.state);
  }
  observe() {
    return this.subject;
  }
  set(patch) {
    this.state = { ...this.state, ...patch };
    this.subject.next(this.state);
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
    this.subject = new ObservableSubject(this.state);
    this._controllers = new Map();
    this.activity = activity;
    this._tasks = new Map(); // transfer id -> activity task handle
  }
  observe() {
    return this.subject;
  }
  #emit() {
    this.subject.next(this.state);
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
