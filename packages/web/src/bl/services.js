// What is left of the data services, plus the derivations that were methods on them.
//
// The explorer, search and API-key services were state bags — a `state`, a `cell`, and a
// `set` that wrote both — and are slices now (bl/state.js). TransfersService stays,
// because it holds things a state snapshot cannot: AbortControllers, per-file retry
// thunks closing over the File itself, and a projection into the activity list.
//
// The functions below were METHODS on those bags. They are derivations, so they belong to
// whoever is asking rather than to whatever happens to hold the data.

import { cell } from '../runtime.js';


/**
 * The nodes the selection refers to — a pure function of explorer state.
 *
 * It was a method, which meant every caller reached for the service to ask a question about
 * data it could already see. As a function it can be used two ways without either being a
 * back door: the explorer QUERY folds it into the view, so the UI is handed the answer; and
 * an effect that needs it right now computes it from the state it already holds.
 *
 * Resolving ids against `items` only finds rows on the LOADED PAGE of the CURRENT
 * collection — and the launcher's rows come from search (which the server scopes to every
 * readable collection) and from recents (which survive a collection switch). So every row
 * reached by searching resolved to nothing, and rename / move-to-trash / copy-link returned
 * silently while `explorer.hasSelection` said there was a selection. Preferring the nodes
 * the selecting caller already held fixes the whole class; the `items` lookup stays for
 * callers that only have ids.
 */
export function selectedNodesOf(state) {
  // Tolerant of a partial state: a view is computed on every emission, including the first
  // one, and a projection that throws takes the whole query down rather than the field.
  const selection = state?.selection || [];
  const held = state?.selectionNodes;
  if (held?.length) return held.filter((n) => selection.includes(n.id));
  return (state?.items || []).filter((i) => selection.includes(i.id));
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
    this.state = { items: [] }; // { id, name, direction, ratio, loaded, total, status, error, retryable }
    this.cell = cell(this.state);
    this._controllers = new Map();
    this.activity = activity;
    this._tasks = new Map(); // transfer id -> activity task handle
    // How to run this transfer again. Held here rather than in state because it closes
    // over the File itself, which is not something a state snapshot should carry.
    //
    // It exists because automatic retry cannot cover everything: a lost upload session is
    // `notFound`, which is correctly classified non-retryable and will never succeed on
    // its own no matter how many times it is tried. Someone has to decide to start over,
    // and the alternative is asking the user to find the file and drag it in again.
    this._retries = new Map();
  }
  observe() {
    return this.cell;
  }
  #emit() {
    this.cell.setValue(this.state);
  }
  /**
   * @param {{retry?: () => Promise<any>}} [opts] how to run this transfer again, if it can be
   */
  start(id, name, total, controller, { retry = null } = {}) {
    this._controllers.set(id, controller);
    if (retry) this._retries.set(id, retry);
    this.state = {
      items: [...this.state.items, {
        id, name, direction: 'up', ratio: 0, loaded: 0, total, status: 'active', error: null,
        // Surfaced in state so the tray renders from a snapshot rather than interrogating
        // the service — it is a fact about the row, like `status`.
        retryable: !!retry,
      }],
    };
    this.#emit();
    this.#task(id, name, total);
  }

  #task(id, name, total) {
    const task = this.activity?.start({
      kind: 'transfer', title: `Uploading ${name}`, total: total || null, unit: 'bytes',
      onCancel: () => this.cancel(id),
    });
    if (task) this._tasks.set(id, task);
  }

  /**
   * Run a failed transfer again, in place.
   *
   * The same row rather than a new one: a retry is another attempt at the thing the user
   * already asked for, and a tray that grew an entry per attempt would report one upload
   * as four.
   */
  retry(id) {
    const again = this._retries.get(id);
    if (!again) return null;
    const item = this.state.items.find((t) => t.id === id);
    if (!item || item.status === 'active') return null;
    return again();
  }

  /** Put an existing row back into flight — see `retry`. */
  restart(id, controller) {
    this._controllers.set(id, controller);
    const item = this.state.items.find((t) => t.id === id);
    this.state = {
      items: this.state.items.map((t) => (t.id === id
        ? { ...t, status: 'active', error: null, ratio: 0, loaded: 0 }
        : t)),
    };
    this.#emit();
    // A fresh activity task: the previous one already ended as failed, and reporting
    // progress into a finished task would leave the panel showing a failure that is
    // actively being retried.
    this.#task(id, item?.name || 'file', item?.total || null);
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
    this._retries.delete(id);
    this.#emit();
  }
  clearDone() {
    const kept = this.state.items.filter((t) => t.status === 'active');
    const keptIds = new Set(kept.map((t) => t.id));
    // Drop the retry thunks of the rows that just left, so a dismissed upload does not
    // hold its File alive for the rest of the session.
    for (const id of [...this._retries.keys()]) if (!keptIds.has(id)) this._retries.delete(id);
    this.state = { items: kept };
    this.#emit();
  }
}


/**
 * The API-key draft as the API wants it, or null when it would grant nothing.
 *
 * A pure function rather than a method, for the same reason as `selectedNodesOf`: it is a
 * derivation, so it belongs to the view that shows it and to the action that submits it,
 * not to the resource that happens to hold the draft.
 */
export function draftScopesOf(state) {
  const caps = state?.draft?.caps || {};
  const scopes = Object.entries(caps)
    .filter(([, list]) => list.length)
    .map(([collectionId, capabilities]) => ({ collectionId, capabilities }));
  return scopes.length ? scopes : null;
}


/**
 * The collection switcher's menu, derived from what the explorer knows.
 *
 * A pure function for the same reason as `selectedNodesOf`: it answers a question about
 * state, so it belongs to the view that shows it. It used to be a closure hung on `app` by
 * `registerCommands` — reachable only through that one field, and impossible to see from
 * the component that rendered it.
 *
 * Items carry `actions`, like every other menu item; see ui/activate.js.
 *
 * @param {object} state explorer state
 * @param {(id?: string) => object} switchTo builds the action for picking a collection
 * @param {() => object} create builds the action for making a new one
 */
/**
 * The administration screen's row per collection.
 *
 * Built here rather than in the component for the same reason `collectionMenuOf` is: these
 * rows carry ACTIONS, and deciding which actions a collection offers is a question about
 * the collection, not about rendering. A component that assembled them would have to know
 * that rotation lives behind Settings and that scanning applies to the OPEN collection.
 *
 * `scan` and `rotate` are sequenced pairs — switch first, then do the thing — because both
 * operate on whatever is open. That is what makes them work from a screen that lists every
 * collection rather than only the current one. Rotation routes to Settings rather than
 * starting one: the estimate and the confirmation live there, and a rotation begun without
 * seeing its cost is exactly the button nobody should have.
 */
export function collectionAdminOf(state, { open, scan, rotate, create }) {
  const current = state?.collectionId;
  const rows = (state?.collections || []).map((c) => ({
    id: c.id,
    name: c.name || c.id,
    driver: c.driver || 'unknown',
    system: !!c.system,
    current: c.id === current,
    // `describeEncryption` gives the fingerprint and nothing secret, so this is safe to show
    // and is the only way to tell two keys apart across a rotation.
    fingerprint: c.encryption?.fingerprint || null,
    encrypted: !!c.encryption,
    capabilities: c.capabilities || [],
    actions: {
      open: [open(c.id)],
      scan: [open(c.id), scan()],
      rotate: c.encryption ? [open(c.id), rotate()] : null,
    },
  }));
  return { rows, canCreate: !!state?.canCreateCollection, create: [create()] };
}

export function collectionMenuOf(state, switchTo, create) {
  // No fallback: this only decides which row gets a tick, and with nothing open the answer
  // is that none of them do. `|| 'default'` ticked a collection the user had not chosen,
  // and on a drive with one actually called "default", the wrong one.
  const current = state?.collectionId;
  const items = (state?.collections || []).map((c) => ({
    label: c.name || c.id,
    icon: c.id === current ? 'check' : 'files',
    actions: [switchTo(c.id)],
  }));
  if (state?.canCreateCollection) {
    if (items.length) items.push({ sep: true });
    items.push({ label: 'New collection…', icon: 'plus', actions: [create()] });
  }
  return items;
}
