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
// INSTANCE IDENTITY IS THE SHARING KEY. ngin keys live realizations by the query INSTANCE —
// `#controllers` is a Map keyed on the object — and nothing anywhere looks at the class or
// the fields. So `new Explorer()` twice is two realizations, two boots and two subscriptions
// to the same underlying cell, quietly, because nothing fails.
//
// Two instances carrying the SAME arguments are still two instances. `new MediaUrl('n1')`
// twice mints two URLs and holds two leases for one file. That is the trap, and "remember to
// memoise" is not a defence: forgetting is silent, and it is the parameterised queries —
// exactly the ones worth sharing — that need it.
//
// So a parameterised query declares `static of = queryOf(TheClass)` and is asked for rather
// than constructed: the same arguments give back the same instance, which makes identity
// mean logical equality and lets both ngin's cache and watchQuery's work. See bl/intern.js.
// Parameterless queries are exported as singletons below. Either way the CLASSES stay
// private to this module and only instances leave it — which is also what stops anyone
// calling `new` on a shared query and quietly getting a second realization.

import { Query } from '@3sln/ngin';
import { queryOf } from './intern.js';
import { selectedNodesOf } from './services.js';
import { prettyKey } from '../platform/keybindings.js';

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
  /**
   * @param {string} dep the engine resource this views
   * @param {(resource: object) => {onDirty: Function, getValue: Function}} cellOf
   */
  /** Empty at the class level; the lease is per instance — see `deps` below. */
  static deps = [];

  /**
   * @param {string} dep the engine resource this views
   * @param {(resource: object) => {onDirty: Function, getValue: Function}} cellOf
   * @param {(value: any, resource: object) => any} [project] shape the value into a view
   */
  constructor(dep, cellOf, project) {
    super();
    this.dep = dep;
    this.cellOf = cellOf;
    this.project = project;
  }

  /**
   * Leased per instance rather than per class, because these all share one class and each
   * views a different resource. ngin leases `constructor.deps` AND `this.deps`, so an
   * instance can name its own.
   */
  get deps() {
    return [this.dep];
  }

  boot(resources, { notify }) {
    const cell = this.cellOf(resources[this.dep]);
    // A service may not exist in every build — `plugins` is absent when the plugin host is
    // not installed, which is why the snapshot has a `?? constant([])` beside it.
    if (!cell) {
      notify(null);
      return;
    }
    const resource = resources[this.dep];
    const read = () => (this.project ? this.project(cell.getValue(), resource) : cell.getValue());
    // The current value first: a subscriber that arrives after the last change should not
    // wait for the next one to find out what is true now.
    notify(read());
    this.off = cell.onDirty(() => notify(read()));
  }

  kill() {
    this.off?.();
    this.off = null;
  }
}

// --- the drive -----------------------------------------------------------------

/**
 * Items, selection, the open collection, and the gate — plus the nodes the selection
 * actually refers to.
 *
 * `selectedNodes` is folded in rather than left as something to call, because resolving it
 * is not trivial: ids alone only match the loaded page of the current collection, and the
 * launcher's rows come from search across every readable one. A view that hands over the
 * answer is the difference between a component knowing what is selected and a component
 * knowing how selection resolution works.
 */
export const explorer = new ServiceQuery('explorer', (r) => r.observe(),
  (v) => ({ ...v, selectedNodes: selectedNodesOf(v) }));
/** Query text, results, and the palette's file list. */
export const search = new ServiceQuery('search', (r) => r.observe());
/** Uploads and downloads in flight. */
export const transfers = new ServiceQuery('transfers', (r) => r.observe());
/** Running tasks and standing issues, both sides of the wire. */
export const activity = new ServiceQuery('activity', (r) => r.observe());
/** Conversations, tags and backlinks for the open item. */
export const social = new ServiceQuery('social', (r) => r.observe());
/** Online state, pinned files, and the queue waiting to sync. */
export const offline = new ServiceQuery('offline', (r) => r.observe());
/** The admin API-key list. */
export const apiKeys = new ServiceQuery('apiKeys', (r) => r.observe());

// --- the shell -----------------------------------------------------------------

/** Which activity is showing, and the rest of the shell's own state. */
export const workbench = new ServiceQuery('workbench', (r) => r.observe());
/** The tab and panel stack. */
export const navigation = new ServiceQuery('workbench', (r) => r.observeNav());
/** Dialogs, menus and panels. */
export const overlay = new ServiceQuery('workbench', (r) => r.observeOverlay());
/** Toasts. */
export const notifications = new ServiceQuery('notifications', (r) => r.observe());
/** Settings, defaults merged with overrides. */
export const settings = new ServiceQuery('settings', (r) => r.observe());
/** The when-clause keys: what is selected, what is open, what is focused. */
export const context = new ServiceQuery('context', (r) => r.observe());
/** Phone, desktop or TV. */
export const viewport = new ServiceQuery('viewport', (r) => r.observe());
/** Whether this browser can transcribe on-device. */
export const voice = new ServiceQuery('voice', (r) => r.observe());
/** Installed plugins; null where the plugin host is not installed. */
export const plugins = new ServiceQuery('plugins', (r) => r?.observe?.());
/** What the UI is in the middle of doing: drafts, captures, ticked boxes. See viewState.js. */
export const viewState = new ServiceQuery('viewState', (r) => r.observe());

/**
 * Contributions of one type — status items, openers, views.
 *
 * Parameterised, so it MUST memoise: a fresh instance per render would boot a second live
 * realization every frame and never share one. Keyed by the type, which is the only thing
 * that distinguishes them.
 */
export const contributionsOfType = (type) => ContributionsOfType.of(type);

class ContributionsOfType extends ServiceQuery {
  static of = queryOf(ContributionsOfType);

  constructor(type) {
    super('contributions', (r) => r.observeType(type));
    this.type = type;
  }
}

// --- view queries ---------------------------------------------------------------
//
// The ones above hand a service's state through unchanged. These COMPOSE: they answer a
// question the UI actually asks, in plain renderable data, with every decision already made.
//
// The rule, and it is the important one: a query emits a VIEW, never a handle. A list of
// commands is a list of descriptions — id, title, whether it is enabled right now — not the
// command objects, and never a `run` function. Interaction goes the other way, as an action
// carrying the thing's id. So a component renders what it is given and dispatches an id; it
// does not reach into a service to find out whether to draw something, and it cannot reach
// into one to make something happen.
//
// That is what takes `platform` out of the components. The status bar used to ask
// `context.evaluate(item.when)` and `plugins.isAvailable(item)` per item, mid-render, which
// is why it needed the bag at all. Those are view decisions; they belong on this side.

/**
 * A query composed from several services rather than passed through from one.
 *
 * `sources` names the cells whose changes should recompute it; `project` builds the value.
 * Split apart because what a view DEPENDS on is usually wider than what it reads from —
 * the palette's command list changes when a contribution is registered, but also when a
 * context key flips, because that is what decides `enabled`.
 */
class ViewQuery extends Query {
  static deps = [];

  /**
   * @param {string[]} deps the engine resources this composes
   * @param {(r: object) => Array<{onDirty: Function}>} sources
   * @param {(r: object) => any} project must return plain data — see the note above
   */
  constructor(deps, sources, project) {
    super();
    this.deps = deps;
    this.sources = sources;
    this.project = project;
  }

  boot(r, { notify }) {
    const emit = () => notify(this.project(r));
    emit();
    this.offs = this.sources(r).filter(Boolean).map((c) => c.onDirty(emit));
  }

  kill() {
    this.offs?.forEach((off) => off());
    this.offs = null;
  }
}

/** Contributions, context keys and plugin health — what most of these views depend on. */
const REGISTRY_DEPS = ['contributions', 'context', 'plugins', 'settings', 'commands', 'keybindings'];
const registries = (r) => [
  r.contributions.observe(),
  r.context.observe(),
  r.plugins?.observe?.(),
  r.settings.observe(),
];

/**
 * The command palette's list: every palette command, with its keybinding label resolved
 * and `enabled` already decided.
 *
 * No `when` expression and no handler. A component shows the title, greys out what is
 * disabled, and dispatches `ExecCommandAction(id)`.
 */
export const paletteCommands = new ViewQuery(REGISTRY_DEPS, registries, (r) => {
  return r.commands.paletteCommands().map((c) => ({
    id: c.id,
    title: c.title ?? c.id,
    category: c.category ?? null,
    icon: c.icon ?? null,
    keybinding: r.keybindings.labelFor(c.id),
    // Two different reasons a command might not run, and they are labelled differently in
    // the palette: `available` is the plugin behind it being reachable, `enabled` also
    // folds in the when-clause. Collapsing them would tag a command disabled by context as
    // "offline", which is a false explanation rather than a vague one.
    available: r.commands.isAvailable(c),
    enabled: r.commands.isEnabled(c.id),
  }));
});

/**
 * Plugin-contributed status bar slots, already filtered to the ones that should show.
 *
 * `when` and availability are resolved here rather than in the render, which is the whole
 * reason the status bar had to carry `platform` at all. `html` is still untrusted plugin
 * markup and is still sanitised at the point it becomes nodes — a query emitting plain data
 * says nothing about that data being safe.
 */
export const statusItems = new ViewQuery(REGISTRY_DEPS, registries, (r) => {
  return r.contributions.ofType('statusItem')
    .filter((i) => i.visible !== false && i.html)
    .filter((i) => !i.when || r.context.evaluate(i.when))
    .filter((i) => r.plugins?.isAvailable?.(i) ?? true)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name)))
    .map((i) => ({
      id: i.id,
      slot: i.slot === 'left' ? 'left' : 'right',
      html: i.html,
      tooltip: i.tooltip ?? null,
      command: i.command ?? null,
    }));
});

/**
 * The effective keybindings, for the settings view: what is bound to what, right now.
 *
 * Everything the UI decides from is decided here — the command's title, whether the binding
 * is a user override, and whether another command answers to the same chord. That last one
 * is why the view carries `clash`: nothing rejects a collision and `#matchFor` scans in
 * reverse so the LAST registration wins, which means binding Delete onto ⌘P silently stops
 * Quick Open from opening. Detecting that needs the whole list at once, which is exactly the
 * sort of thing a component rendering one row cannot do and a view can.
 */
export const keybindings = new ViewQuery(REGISTRY_DEPS, registries, (r) => {
  const resolved = r.keybindings.resolved();
  const overrides = r.keybindings.overrides();
  const perKey = new Map();
  for (const b of resolved) perKey.set(b.key, (perKey.get(b.key) || 0) + 1);
  return resolved.map((b) => ({
    bindingId: b.bindingId,
    command: b.command,
    title: r.contributions.get(b.command)?.title ?? b.command,
    key: b.key,
    label: prettyKey(b.key),
    custom: !!overrides[b.bindingId],
    clash: perKey.get(b.key) > 1,
  }));
});

/**
 * What the server can do: which storage drivers it offers, whether it can suggest searches.
 *
 * This one FETCHES rather than watching a cell, and it is the reason the last `rerender`-
 * shaped hack can go. The answer used to be assigned onto `platform` at boot and followed by
 * `workbench.touch()` — a poke at an unrelated store purely to make the shell redraw,
 * because nothing invalidated when a plain field was written. A query has somewhere for the
 * value to arrive, so nothing has to be told about it.
 *
 * The promise is kept, not just the value. ngin re-boots a query when it is observed again
 * after going idle, and this must not become a second HTTP call: what the server can do does
 * not change under a running page. (A one-shot `fetch()` query would be the obvious fit and
 * is wrong here for the same reason — ngin evicts after one, deliberately, so that the next
 * subscriber gets a fresh answer rather than a stale one that can never refresh. That is the
 * right default and the opposite of what this wants.)
 */
class Capabilities extends Query {
  static deps = ['api'];

  /** Not yet known, as against "knows there are none" — every reader already treats it so. */
  initial = null;

  async boot({ api }, { notify }) {
    this.promise ??= api.capabilities();
    notify(await this.promise);
  }

  kill() {}
}

export const capabilities = new Capabilities();
