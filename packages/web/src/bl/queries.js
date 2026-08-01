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
import { selectedNodesOf, draftScopesOf, collectionMenuOf, collectionAdminOf } from './services.js';
import { ExecCommandAction, LoadSidecarAction, ClearSidecarAction, LoadRotationAction } from './actions.js';
import { ASSOC_KEY, describeOpener } from './openers.js';
import { rankCommands } from './match.js';
import { statusFactsOf, driveConditionOf } from './status.js';
import { launcherGroupsOf, launcherMode, searchHelpOf } from './launcher.js';
import { pickView } from './views.js';
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
    return [this.dep, 'appState'];
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
    hold(resources, this, cell.onDirty(() => notify(read())));
  }

  kill(resources) {
    release(resources, this);
  }
}

/**
 * Where a live query keeps its subscription.
 *
 * NOT on the query. These instances are module-level singletons, interned so that the same
 * arguments give back the same object — which is what makes ngin share one realization per
 * engine. Writing `this.off` on a shared instance is therefore writing per-REALIZATION
 * state onto something that outlives any one of them: two engines observing the same
 * instance boot it twice, the second overwrites the first's unsubscribe, and killing either
 * releases the wrong one while the other leaks.
 *
 * `appState` is a provider, so it is per engine; keyed by the instance, an entry is per
 * (engine, instance) — which is exactly one realization. The query stays a description of
 * what to watch, and nothing about it changes when it is being watched.
 */
function hold(resources, query, off) {
  resources.appState.set(query, off);
}

function release(resources, query) {
  const off = resources.appState?.get(query);
  if (Array.isArray(off)) off.forEach((fn) => fn());
  else off?.();
  resources.appState?.delete(query);
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
export const explorer = new ServiceQuery('explorer', (r) => r.observe(), (v) => ({
  ...v,
  selectedNodes: selectedNodesOf(v),
  // The collection switcher's rows. In the view because it is a question about state, and
  // because the component that shows it could not otherwise see where it came from.
  collectionMenu: collectionMenuOf(v,
    (id) => new ExecCommandAction('collections.switch', id),
    () => new ExecCommandAction('collections.create')),
  // The administration screen's view of the same collections: what each is on, whether it
  // is sealed, and what may be done to it.
  collectionAdmin: collectionAdminOf(v, {
    open: (id) => new ExecCommandAction('collections.switch', id),
    scan: () => new ExecCommandAction('workbench.scanCollection'),
    rotate: () => new ExecCommandAction('workbench.openSettings'),
    create: () => new ExecCommandAction('collections.create'),
  }),
}));
/** Query text, results, and the palette's file list. */
export const search = new ServiceQuery('search', (r) => r.observe());
/** Uploads and downloads in flight. */
export const transfers = new ServiceQuery('transfers', (r) => r.observe());
/** Running tasks and standing issues, both sides of the wire. */
export const activity = new ServiceQuery('activity', (r) => r.observe());
/** Conversations, tags and backlinks for the open item. */
export const social = new ServiceQuery('social', (r) => r.observe());
/**
 * Online state, pinned files, and the queue waiting to sync.
 *
 * `pinnedIds` is folded in so a component can ask whether THIS file is pinned without
 * calling a method on the service to find out. A Set rather than a repeated scan: the
 * question is asked once per row.
 */
export const offline = new ServiceQuery('offline', (r) => r.observe(),
  (v) => ({ ...v, pinnedIds: new Set((v?.pins || []).map((p) => p.id)) }));
/**
 * The open collection's key, and any rotation running over it.
 *
 * Keyed by collection, so switching collections is a different query rather than a change
 * to notice. `bootAction` loads it when the settings screen first looks — the alternative,
 * which the API-keys section still does, is to dispatch from inside a render behind a
 * module-level "have I asked yet" flag, which is a render with a side effect.
 *
 * It POLLS while a rotation is running, because the work is happening on the server and
 * there is nothing to push. The interval belongs to the realization: it starts when
 * somebody looks and stops when they look away, so a settings screen nobody has open costs
 * nothing.
 */
export const rotationFor = (collectionId) => RotationView.of(collectionId);

class RotationView extends Query {
  static deps = ['rotation', 'appState', 'engine'];
  static of = queryOf(RotationView);

  constructor(collectionId) {
    super();
    this.collectionId = collectionId;
    this.bootAction = new LoadRotationAction();
  }

  boot(r, { notify }) {
    const cell = r.rotation.observe();
    notify(cell.getValue());
    const off = cell.onDirty(() => notify(cell.getValue()));
    const timer = setInterval(() => {
      if (r.rotation.get().rotation?.status === 'running') r.engine.dispatch(new LoadRotationAction());
    }, 2500);
    hold(r, this, [off, () => clearInterval(timer)]);
  }

  kill(r) {
    release(r, this);
  }
}
/** The admin API-key list, with the unsubmitted draft resolved into what it would grant. */
export const apiKeys = new ServiceQuery('apiKeys', (r) => r.observe(),
  (v) => ({ ...v, draftScopes: draftScopesOf(v) }));

// --- the shell -----------------------------------------------------------------

/** Which activity is showing, and the rest of the shell's own state. */
export const workbench = new ServiceQuery('workbench', (r) => r.observe());
/** The tab and panel stack. */
export const navigation = new ServiceQuery('navigation', (r) => r.observe());
/** Dialogs, menus and panels. */
export const overlay = new ServiceQuery('overlay', (r) => r.observe());
/** Toasts. */
export const notifications = new ServiceQuery('notifications', (r) => r.observe());
/** Settings, defaults merged with overrides. */
export const settings = new ServiceQuery('settings', (r) => r.observe());
/**
 * The settings SCHEMA, grouped by category, for the screen that edits them.
 *
 * Separate from `settings` rather than folded in, because that one emits the effective
 * values keyed by setting name — adding a `groups` key to it would put a made-up entry in
 * among the real ones.
 */
export const settingsGroups = new ServiceQuery('settings', (r) => r.observe(), (_v, r) => r.grouped());

/** The when-clause keys: what is selected, what is open, what is focused. */
export const context = new ServiceQuery('context', (r) => r.observe());
/** Phone, desktop or TV. */
export const viewport = new ServiceQuery('viewport', (r) => r.observe());
/**
 * Whether this browser can transcribe on-device, and whether it is listening now.
 *
 * `canListen` is folded in: it is a question about the state, so a component should not
 * have to call the service to find out.
 */
export const voice = new ServiceQuery('voice', (r) => r.observe(),
  (v, r) => ({ ...v, canListen: !!r.canListen?.() }));
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
    this.deps = [...deps, 'appState'];
    this.sources = sources;
    this.project = project;
  }

  boot(r, { notify }) {
    const emit = () => notify(this.project(r));
    emit();
    hold(r, this, this.sources(r).filter(Boolean).map((c) => c.onDirty(emit)));
  }

  kill(r) {
    release(r, this);
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
export const paletteCommands = new ViewQuery(REGISTRY_DEPS, registries, paletteCommandsOf);

function paletteCommandsOf(r) {
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
}

// The same list, narrowed to what was typed.
//
// Ranking used to happen mid-render, in two components, with two different algorithms (see
// bl/match.js). The typed term is engine state — the palette's lives in the overlay — so
// this is an ordinary query with no arguments, and the ranking is settled before a
// component sees anything. The launcher's `!` mode ranks the same way inside
// `launcherContent`, which already holds everything it needs.
const OVERLAY_DEPS = [...REGISTRY_DEPS, 'overlay', 'workbench'];
const withShell = (r) => [...registries(r), r.workbench.observe(), r.overlay.observe()];

/** What the command palette should list right now. */
export const paletteMatches = new ViewQuery(OVERLAY_DEPS, withShell, (r) =>
  rankCommands(paletteCommandsOf(r), r.overlay.get().palette?.query || ''));


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
 * What the launcher is showing: its groups, the view drawing them, and the help offered
 * when a search found nothing. See bl/launcher.js.
 *
 * Parameterised by `modal` — the double-shift overlay and the home screen are BOTH on
 * screen when the overlay is up, so which instance is rendering is the one input that
 * genuinely is not engine state. Two values, so interning gives at most two realizations.
 *
 * `view` is folded in because choosing it needs the items, and the items are right here.
 * That was the last thing keeping `pickView` outside the engine.
 */
export const launcherContent = (modal = false) => LauncherContent.of(!!modal);

const LAUNCHER_DEPS = [...REGISTRY_DEPS, 'explorer', 'search', 'workbench', 'navigation', 'offline', 'capabilities'];

class LauncherContent extends ViewQuery {
  static of = queryOf(LauncherContent);

  constructor(modal) {
    super(
      LAUNCHER_DEPS,
      (r) => [
        ...registries(r),
        r.explorer.observe(), r.search.observe(),
        r.workbench.observe(), r.navigation.observe(), r.offline.observe(),
        // Capabilities arrive after the first render — the provider hands out a cell that
        // fills in — so this has to be watched, not merely read, or the search help would
        // never appear on a drive whose prompt the server supplies.
        r.capabilities,
      ],
      (r) => {
        const wb = r.workbench.get();
        const off = r.offline.observe().getValue() || {};
        const slices = {
          ex: r.explorer.observe().getValue() || {},
          se: r.search.observe().getValue() || {},
          nav: r.navigation.observe().getValue() || {},
          query: wb.launch.query || '',
          commandMatches: rankCommands(paletteCommandsOf(r), (wb.launch.query || '').slice(1)),
          pinnedIds: new Set((off.pins || []).map((p) => p.id)),
          keys: commandKeysOf(r),
        };
        const groups = launcherGroupsOf(slices, this.modal);
        const mode = launcherMode(slices.query);
        return {
          groups,
          mode,
          // Which view draws them. Needs the nodes on screen, which is exactly what this
          // query has just worked out — see bl/views.js. This was the last thing keeping
          // the choice outside the engine.
          view: pickView(viewsOf(r), groups.flatMap((g) => g.items),
            mode === 'search' ? slices.se.resolved?.view ?? null : null),
          // What to offer when a search found nothing. Both halves are here now: whether
          // an offer applies at all (a search ran, it succeeded, it found nothing) and
          // what to suggest, which the server decides — see the `capabilities` resource.
          help: searchHelpOf({
            eligible: mode !== 'command'
              && !!slices.se.ran && !slices.se.loading && !slices.se.error
              && !(slices.se.results || []).length,
            caps: r.capabilities.getValue(),
          }),
        };
      },
    );
    this.modal = modal;
  }
}

/**
 * What the drive is doing and how full it is — see bl/status.js.
 *
 * Both shells render these, in different shapes. Derived once, here, because the last time
 * each worked them out for itself the phone bar showed a raw `col_…` id where the desktop
 * bar showed the collection's name.
 */
export const statusFacts = new ViewQuery(
  ['explorer', 'transfers', 'activity', 'offline'],
  (r) => [r.explorer.observe(), r.transfers.observe(), r.activity.observe(), r.offline.observe()],
  (r) => {
    const facts = statusFactsOf({
      ex: r.explorer.observe().getValue(),
      tr: r.transfers.observe().getValue(),
      act: r.activity.observe().getValue(),
      off: r.offline.observe().getValue(),
    });
    // The single most urgent thing, for a shell with room for one glyph. Folded in rather
    // than left to the phone, because deciding that offline outranks a standing problem is
    // a claim about what someone needs to know.
    return { ...facts, condition: driveConditionOf(facts) };
  },
);

/**
 * Every opener that could run right now — `when` and plugin availability already decided,
 * and the plugin's display name resolved into `source`.
 *
 * The SELECTOR is left on, which is the whole trick: which openers exist is a question
 * about engine state and belongs here, but which of them suits the file a component is
 * drawing is pure matching against data that component already holds. So the query answers
 * the reactive half and `openersFor` (a pure function, below) answers the rest — rather
 * than the query being parameterised by a node, which would need one live realization per
 * file on screen.
 *
 * Descriptors, not contributions: no `component`, no `entry`. Rendering resolves the
 * callable by id — see ui/components/openers.
 */
export const openers = new ViewQuery(REGISTRY_DEPS, registries, (r) =>
  r.contributions.ofType('opener')
    .filter((o) => !o.when || r.context.evaluate(o.when))
    .filter((o) => r.plugins?.isAvailable?.(o) ?? true)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .map((o) => describeOpener(o, r.plugins)));

/**
 * How results can be drawn, and which one the user pinned.
 *
 * `saved` travels with the list because choosing between them needs both, and a component
 * that had to fetch the setting separately would be reaching for `settings` mid-render —
 * which is what this replaces. The CHOICE itself is `pickView`, a pure function, because it
 * also depends on the items on screen, and items are not something to key a query by.
 *
 * `render` and `move` come along. The rule about a query emitting a view rather than a
 * handle is about SIDE EFFECTS — a `run()` that mutates the drive is a back door around
 * actions and the feed. A view's renderer is a pure vnode builder over the arguments it is
 * given, so passing it is passing data; making the component look it up by id would have
 * been the registry access this is trying to remove, relocated rather than deleted.
 */
export const views = new ViewQuery(REGISTRY_DEPS, registries, viewsOf);

function viewsOf(r) {
  return {
    views: r.contributions.ofType('view')
      .filter((v) => !v.when || r.context.evaluate(v.when))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .map((v) => ({
        id: v.id,
        title: v.title ?? v.name ?? v.id,
        icon: v.icon ?? null,
        match: v.match ?? null,
        render: v.render,
        move: v.move,
      })),
    saved: r.settings.get('explorer.view') || null,
  };
}

/**
 * The saved "always open .pdf with…" choices, for the settings screen.
 *
 * `missing` is decided here: an association can name an opener that has since been
 * uninstalled, and the row has to say so rather than showing a bare id.
 */
export const openerAssociations = new ViewQuery(REGISTRY_DEPS, registries, (r) => {
  const assoc = r.settings.get(ASSOC_KEY) || {};
  return Object.entries(assoc).map(([typeKey, openerId]) => {
    const opener = r.contributions.get(openerId);
    return { typeKey, openerId, openerTitle: opener?.title || openerId, missing: !opener };
  });
});

/**
 * The conversation, tags and backlinks for one file.
 *
 * Keyed by node, and the KEY is what replaces a reaction. This used to be an `effect` in
 * bl/index.js watching the nav stack with a module-scoped `let lastTab` for change
 * detection, calling `social.loadSidecar` directly — a subscription outside the engine
 * doing effect work, and the last place that still worked that way.
 *
 * ngin already brackets this. `bootAction` is dispatched when the first observer arrives
 * and `killAction` when the last one leaves, so opening a file loads its conversation and
 * closing it clears it, because the query is alive for exactly as long as something is
 * looking. Switching files is not a change to detect: it is one instance dying and another
 * booting.
 *
 * The clear is SCOPED to this node. Kill and boot are not ordered against each other, so
 * switching from A to B can kill A after B has booted — an unscoped clear would then wipe
 * the sidecar B just asked for. It is the same race the loading path already guards, and
 * naming the node is what makes it impossible rather than unlikely.
 */
export const sidecarFor = (nodeId) => Sidecar.of(nodeId);

class Sidecar extends ServiceQuery {
  static of = queryOf(Sidecar);

  constructor(nodeId) {
    super('social', (r) => r.observe(), (v) => v?.sidecar ?? null);
    this.nodeId = nodeId;
    this.bootAction = new LoadSidecarAction(nodeId);
    this.killAction = new ClearSidecarAction(nodeId);
  }
}

/**
 * A file's text, capped.
 *
 * The first query keyed by something unbounded, which is what `queryOf` interning and the
 * weak eviction were built for: one instance per (node, cap), shared by every viewer
 * looking at that file, and collected once nothing is. A viewer that scrolls out of the
 * tree stops observing, ngin kills the realization, and the text goes with it — no cache
 * to invalidate and nothing to remember to release.
 *
 * `size` is a hint the API uses to decide whether a range request is worth it. It is part
 * of the key because it is part of the request, and it is derived from the node id anyway,
 * so it cannot split one file into two entries.
 *
 * Capped at the TRANSFER, not just the render: a character limit in a viewer stops us
 * laying out a huge document, but the whole file still crosses the wire without this.
 */
export class FileText extends Query {
  static deps = ['api'];

  static of = queryOf(FileText);

  constructor(nodeId, maxBytes, size) {
    super();
    this.nodeId = nodeId;
    this.maxBytes = maxBytes;
    this.size = size;
  }

  async boot({ api }, { notify }) {
    notify(await api.readTextCapped(this.nodeId, { maxBytes: this.maxBytes, size: this.size }));
  }

  kill() {}
}

/**
 * Command id → its keybinding label, for anything that shows a shortcut next to an action.
 *
 * Hardcoding "⌘⇧L" told a Windows or Linux user about a key their machine does not have,
 * and told everyone the default even after they had rebound it. A map rather than a list
 * because every caller is asking about one command it already knows the id of.
 */
export const commandKeys = new ViewQuery(REGISTRY_DEPS, registries, commandKeysOf);

function commandKeysOf(r) {
  return Object.fromEntries(r.keybindings.resolved()
    .map((b) => [b.command, r.keybindings.labelFor(b.command)])
    .filter(([, label]) => label));
}

/**
 * What this deployment can do.
 *
 * A plain view over the `capabilities` resource — see bl/index.js, where the provider hands
 * out a cell that fills in once the server answers. This used to be a query that kept the
 * PROMISE on its own instance so a re-boot would not re-fetch, which is a cache with no
 * invalidation living inside a view; and it needed `initial = null` to stop the shell going
 * PENDING while the request was in flight. Both go away when the fetch belongs to the
 * provider: the cell already holds null, and reading a cell is all this does.
 */
export const capabilities = new ServiceQuery('capabilities', (r) => r);
