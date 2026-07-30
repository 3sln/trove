// The drive's state, as engine queries.
//
// The web layer grew a second reactive system beside the engine: services holding cells, a
// `platform` bag of subsystems, an `app` bag of stores, and one derived snapshot threaded
// through every component. ngin already had all of it — see queries.js in the package:
// `QueryController` is "one live realization of a query instance, shared by all of its
// observers", `boot`/`kill` bracket a query's life, and a lease holds the providers it needs
// for exactly that long.
//
// This is step one of moving onto it (docs/tickets/009). Each query here wraps the service
// that exists today, so nothing in the UI has to change yet and the two describe the same
// state rather than competing to. The services are deleted in a later phase, at which point
// these stop wrapping and simply hold.
//
// INSTANCE IDENTITY IS THE SHARING KEY. ngin keys live realizations by the query INSTANCE,
// so `new Explorer()` twice is two realizations, two boots, and two subscriptions to the
// same underlying cell — quietly, because nothing fails. Parameterless queries are therefore
// exported as singletons, and anything parameterised has to memoise. Import the instance,
// never the class.

import { Query } from '@3sln/ngin';
import { localState } from '../ui/localState.js';

/**
 * A live query over one of the existing cell-backed services.
 *
 * The service exposes dodo's Cell protocol — `onDirty(fn)` to learn it changed, `getValue()`
 * to read it — and a query wants push. Bridging is two lines, so rather than write them per
 * service this takes the cell as a function of the leased `app`.
 *
 * It reads the CELL, never the service's own `state` field. Most services keep both in step
 * (`this.state = {...}; this.cell.setValue(this.state)`) so the two usually agree, but not
 * all of them do — `settings`' cell holds `effective()`, the defaults merged with the
 * overrides, and there is no `state` field at all. The existing snapshot passes cells to
 * `derive`, which hands it their values; reading the same way is what makes these queries
 * and the snapshot describe the same state rather than two subtly different ones.
 */
class ServiceQuery extends Query {
  static deps = ['app'];

  /** @param {(app: object) => {onDirty: Function, getValue: Function}} cellOf */
  constructor(cellOf) {
    super();
    this.cellOf = cellOf;
  }

  boot({ app }, { notify }) {
    const cell = this.cellOf(app);
    // A service may not exist in every build — `plugins` is absent when the plugin host is
    // not installed, which is why the snapshot has a `?? constant([])` beside it.
    if (!cell) {
      notify(null);
      return;
    }
    // The current value first: a subscriber that arrives after the last change should not
    // wait for the next one to find out what is true now.
    notify(cell.getValue());
    this.off = cell.onDirty(() => notify(cell.getValue()));
  }

  kill() {
    this.off?.();
    this.off = null;
  }
}

// --- the drive -----------------------------------------------------------------

/** Items, selection, the open collection, and the gate. */
export const explorer = new ServiceQuery((app) => app.explorer.observe());
/** Query text, results, and the palette's file list. */
export const search = new ServiceQuery((app) => app.search.observe());
/** Uploads and downloads in flight. */
export const transfers = new ServiceQuery((app) => app.transfers.observe());
/** Running tasks and standing issues, both sides of the wire. */
export const activity = new ServiceQuery((app) => app.activity.observe());
/** Conversations, tags and backlinks for the open item. */
export const social = new ServiceQuery((app) => app.social.observe());
/** Online state, pinned files, and the queue waiting to sync. */
export const offline = new ServiceQuery((app) => app.offline.observe());
/** The admin API-key list. */
export const apiKeys = new ServiceQuery((app) => app.apiKeys.observe());

// --- the shell -----------------------------------------------------------------

/** Which activity is showing, and the rest of the shell's own state. */
export const workbench = new ServiceQuery((app) => app.platform.workbench.observe());
/** The tab and panel stack. */
export const navigation = new ServiceQuery((app) => app.platform.workbench.observeNav());
/** Dialogs, menus and panels. */
export const overlay = new ServiceQuery((app) => app.platform.workbench.observeOverlay());
/** Toasts. */
export const notifications = new ServiceQuery((app) => app.platform.notifications.observe());
/** Settings, defaults merged with overrides. */
export const settings = new ServiceQuery((app) => app.platform.settings.observe());
/** The when-clause keys: what is selected, what is open, what is focused. */
export const context = new ServiceQuery((app) => app.platform.context.observe());
/** Phone, desktop or TV. */
export const viewport = new ServiceQuery((app) => app.platform.viewport.observe());
/** Whether this browser can transcribe on-device. */
export const voice = new ServiceQuery((app) => app.platform.voice.observe());
/** Installed plugins; null where the plugin host is not installed. */
export const plugins = new ServiceQuery((app) => app.platform.plugins?.observe());
/**
 * Component-local UI state that still has to reach the render — see ui/localState.js.
 *
 * A module singleton rather than something hanging off `app`, so this ignores the leased
 * resource. It still goes through a query so that a component reads it the same way it
 * reads everything else, and so it has somewhere to land when the rest of the bag is gone.
 */
export const localUi = new ServiceQuery(() => localState.observe());

/**
 * Contributions of one type — status items, openers, views.
 *
 * Parameterised, so it MUST memoise: a fresh instance per render would boot a second live
 * realization every frame and never share one. Keyed by the type, which is the only thing
 * that distinguishes them.
 */
const contributionQueries = new Map();
export function contributionsOfType(type) {
  let q = contributionQueries.get(type);
  if (!q) {
    q = new ServiceQuery((app) => app.platform.contributions.observeType(type));
    contributionQueries.set(type, q);
  }
  return q;
}
