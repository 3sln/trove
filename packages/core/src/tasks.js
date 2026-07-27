// TaskRegistry — work that is happening right now and takes long enough that someone
// should be able to watch it.
//
// Deliberately IN-MEMORY and per-process. A task describes work in flight, and work in
// flight does not survive the process doing it: if the server restarts mid-reindex,
// that reindex is not "still running", it is gone. Persisting tasks would mean
// resurrecting rows that claim to be running while nothing is, which is worse than
// forgetting them. What must outlive the process is the *consequence* of a failure —
// and that is an Issue (issues.js), which is durable precisely because it is a standing
// fact rather than an in-flight activity.
//
// Progress comes in two shapes, because honest progress does:
//   • determinate   — done / total, with a unit ("142 / 3,100 items")
//   • indeterminate — total is null; we know it's working, not how far along
// A caller that doesn't know the total must NOT invent one. A progress bar that lies is
// worse than a spinner that doesn't.

import { newId } from './util.js';

/** How long a finished task stays listable, so a client polling every second sees it end. */
const DEFAULT_RETAIN_MS = 60_000;
/** Hard cap on retained finished tasks, so a chatty producer can't grow this forever. */
const MAX_FINISHED = 100;

export class TaskRegistry {
  /**
   * @param {{retainMs?: number, now?: () => number}} [opts]
   */
  constructor({ retainMs = DEFAULT_RETAIN_MS, now = () => Date.now() } = {}) {
    this.retainMs = retainMs;
    this.now = now;
    this.tasks = new Map(); // id -> task record
    this._controllers = new Map(); // id -> AbortController
    this._inFlight = new Set(); // promises for tasks still running — see pending()
  }

  /**
   * Begin a task. Prefer `run()` — it can't leak a task that never finishes.
   *
   * @param {object} spec
   * @param {string} spec.title        what the user sees ("Rebuilding the search index")
   * @param {string} [spec.kind]       coarse grouping ('index', 'transfer', …)
   * @param {string} [spec.detail]     a line under the title, updated as it goes
   * @param {number|null} [spec.total] omit for indeterminate — do not guess
   * @param {string} [spec.unit]       'items', 'files', 'bytes'
   * @param {string} [spec.collectionId] scopes visibility to readers of that collection
   * @param {boolean} [spec.cancellable]
   */
  start(spec = {}) {
    const id = spec.id || newId('tsk');
    const controller = spec.cancellable ? new AbortController() : null;
    if (controller) this._controllers.set(id, controller);
    const task = {
      id,
      kind: spec.kind || 'general',
      title: spec.title || 'Working',
      detail: spec.detail || null,
      status: 'running',
      done: 0,
      total: spec.total ?? null,
      unit: spec.unit || null,
      collectionId: spec.collectionId ?? null,
      cancellable: !!controller,
      startedAt: this.now(),
      endedAt: null,
      error: null,
    };
    this.tasks.set(id, task);
    this.#prune();
    return this.#handle(task, controller);
  }

  /**
   * Run `fn` as a task, finishing it however `fn` ends. This is the shape callers
   * should reach for: a `start()` whose owner throws before `succeed()`/`fail()` leaves
   * a task spinning in the UI forever, describing work that stopped long ago.
   *
   * @param {object} spec  as `start`
   * @param {(handle: object) => Promise<any>} fn
   */
  async run(spec, fn) {
    return this.begin(spec, fn).done;
  }

  /**
   * As `run()`, but hands back the task record immediately alongside the promise.
   *
   * A route that starts long work has to answer with something the client can watch,
   * and it cannot wait for the work to finish to find out what that something is. The
   * record exists the moment the task starts; this is how a caller gets at it without
   * awaiting the whole job.
   *
   * @returns {{task: object, done: Promise<any>}}
   */
  begin(spec, fn) {
    const handle = this.start(spec);
    const promise = (async () => {
      try {
        const result = await fn(handle);
        handle.succeed(result);
        return result;
      } catch (err) {
        handle.fail(err);
        throw err;
      }
    })();
    // Track it so `pending()` can hand the whole set to a runtime that needs to be told
    // the work exists — see below.
    this._inFlight.add(promise);
    promise.catch(() => {}).finally(() => this._inFlight.delete(promise));
    return { task: this.get(handle.id), done: promise };
  }

  /**
   * Every task still running, as one promise — or null when nothing is.
   *
   * A route starts a task and returns immediately, because the work takes minutes and
   * holding the request open for it would just time out. On a long-lived process that
   * is enough: the promise keeps running because the process does.
   *
   * On Cloudflare Workers it is not. The isolate may be discarded as soon as the
   * response resolves, and a promise nobody declared is simply cancelled part-way — a
   * scan that silently did a third of the bucket. `ctx.waitUntil` is how a Worker says
   * "the response is done but I am not", and it needs something to wait on. This is it.
   */
  pending() {
    if (!this._inFlight.size) return null;
    return Promise.allSettled([...this._inFlight]);
  }

  #handle(task, controller) {
    const set = (patch) => {
      // A finished task is final: a late progress callback from work that has already
      // been cancelled must not resurrect it as "running".
      if (task.status !== 'running') return;
      Object.assign(task, patch);
    };
    return {
      id: task.id,
      get signal() { return controller?.signal; },
      get cancelled() { return !!controller?.signal.aborted; },
      /** @param {{done?: number, total?: number|null, unit?: string, detail?: string}} p */
      progress: (p = {}) => set({
        done: p.done ?? task.done,
        total: p.total === undefined ? task.total : p.total,
        unit: p.unit ?? task.unit,
        detail: p.detail ?? task.detail,
      }),
      succeed: (detail) => {
        if (task.status !== 'running') return; // already cancelled/failed
        Object.assign(task, {
          status: 'done', endedAt: this.now(),
          detail: typeof detail === 'string' ? detail : task.detail,
          done: task.total ?? task.done,
        });
        this._controllers.delete(task.id);
      },
      fail: (err) => {
        if (task.status !== 'running') return;
        Object.assign(task, {
          status: task.cancelled ? 'cancelled' : 'failed',
          endedAt: this.now(),
          error: err?.message || String(err || 'failed'),
        });
        this._controllers.delete(task.id);
      },
    };
  }

  /**
   * Ask a task to stop. Cancellation is COOPERATIVE — this aborts the signal and marks
   * the task, but the work itself decides when to notice. Marking it here rather than
   * waiting for the worker means the UI reflects the click immediately, which is the
   * behaviour a user expects from a Cancel button.
   */
  cancel(id) {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return false;
    this._controllers.get(id)?.abort();
    Object.assign(task, { status: 'cancelled', endedAt: this.now() });
    this._controllers.delete(id);
    return true;
  }

  get(id) {
    return this.tasks.get(id) ? { ...this.tasks.get(id) } : null;
  }

  /**
   * Running tasks first (they're what the user is waiting on), then recently finished
   * newest-first — so a client that polls at 1 Hz still sees a task that started and
   * ended between two polls.
   *
   * @param {{collectionIds?: string[]}} [opts] restrict to tasks the caller may see;
   *   a task with no collectionId is drive-wide and only listed when `collectionIds`
   *   is undefined (collections disabled) or the caller is explicitly allowed it.
   */
  list({ collectionIds, includeGlobal = true } = {}) {
    this.#prune();
    const visible = [...this.tasks.values()].filter((t) => {
      if (t.collectionId == null) return includeGlobal;
      return !collectionIds || collectionIds.includes(t.collectionId);
    });
    const running = visible.filter((t) => t.status === 'running').sort((a, b) => a.startedAt - b.startedAt);
    const finished = visible.filter((t) => t.status !== 'running').sort((a, b) => b.endedAt - a.endedAt);
    return [...running, ...finished].map((t) => ({ ...t }));
  }

  /** Drop a finished task from the list early (the user dismissed it). */
  dismiss(id) {
    const task = this.tasks.get(id);
    if (task && task.status !== 'running') this.tasks.delete(id);
  }

  #prune() {
    const cutoff = this.now() - this.retainMs;
    const finished = [];
    for (const task of this.tasks.values()) {
      if (task.status === 'running') continue;
      if (task.endedAt < cutoff) this.tasks.delete(task.id);
      else finished.push(task);
    }
    if (finished.length > MAX_FINISHED) {
      finished.sort((a, b) => a.endedAt - b.endedAt);
      for (const task of finished.slice(0, finished.length - MAX_FINISHED)) this.tasks.delete(task.id);
    }
  }
}
