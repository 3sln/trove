// Reactive data services the workbench renders from. These hold *data* state
// (the current folder's contents, search results, in-flight transfers) as
// opposed to the shell's UI state (WorkbenchService). ngin Actions mutate them;
// the UI `watch`es them. Each is a plain ObservableSubject wrapper so the render
// layer stays declarative.

import { ObservableSubject } from '../runtime.js';

export class ExplorerService {
  constructor(settings) {
    this.settings = settings;
    this.state = {
      folder: null, breadcrumb: [], items: [], loading: false, error: null,
      selection: [], sort: settings.get('explorer.sort'), order: settings.get('explorer.sortOrder'),
      collectionId: 'default', collections: [], canCreateCollection: false,
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
  toggleSelect(id) {
    const has = this.state.selection.includes(id);
    this.set({ selection: has ? this.state.selection.filter((x) => x !== id) : [...this.state.selection, id] });
  }
  clearSelection() {
    if (this.state.selection.length) this.set({ selection: [] });
  }
  selectedNodes() {
    return this.state.items.filter((i) => this.state.selection.includes(i.id));
  }
}

export class SearchClientService {
  constructor() {
    this.state = { query: '', mode: 'hybrid', results: [], loading: false, error: null, ran: false, paletteFiles: [] };
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

export class TransfersService {
  constructor() {
    this.state = { items: [] }; // { id, name, direction, ratio, loaded, total, status, error }
    this.subject = new ObservableSubject(this.state);
    this._controllers = new Map();
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
  }
  progress(id, { loaded, total, ratio }) {
    this.state = { items: this.state.items.map((t) => (t.id === id ? { ...t, loaded, total, ratio } : t)) };
    this.#emit();
  }
  finish(id, status = 'done', error = null) {
    this.state = { items: this.state.items.map((t) => (t.id === id ? { ...t, status, error, ratio: status === 'done' ? 1 : t.ratio } : t)) };
    this._controllers.delete(id);
    this.#emit();
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
  activeCount() {
    return this.state.items.filter((t) => t.status === 'active').length;
  }
}
