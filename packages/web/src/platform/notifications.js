// NotificationService — transient toasts + a small log. Everything user-facing
// that fails routes here so problems are never silent. Reactive: the status/UI
// watches `observe()`.

import { ObservableSubject } from '../runtime.js';

let seq = 0;

export class NotificationService {
  constructor() {
    this.items = [];
    this.subject = new ObservableSubject([]);
  }
  observe() {
    return this.subject;
  }
  #push(level, message, opts = {}) {
    const item = {
      id: ++seq, level, message,
      actions: opts.actions || null,
      createdAt: Date.now(),
      sticky: opts.sticky || level === 'error',
    };
    this.items = [...this.items, item];
    this.subject.next(this.items);
    if (!item.sticky) setTimeout(() => this.dismiss(item.id), opts.timeout ?? 4000);
    return item.id;
  }
  info(m, o) {
    return this.#push('info', m, o);
  }
  success(m, o) {
    return this.#push('success', m, o);
  }
  warn(m, o) {
    return this.#push('warn', m, o);
  }
  error(m, o) {
    return this.#push('error', m, o);
  }
  /** Update a notification in place (e.g. a progress message). */
  update(id, patch) {
    this.items = this.items.map((i) => (i.id === id ? { ...i, ...patch } : i));
    this.subject.next(this.items);
  }
  dismiss(id) {
    this.items = this.items.filter((i) => i.id !== id);
    this.subject.next(this.items);
  }
}
