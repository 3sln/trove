// The drive's state as engine queries.
//
// Three properties carry the whole design (docs/tickets/009): a query is LIVE, one
// realization is SHARED by every observer, and it TEARS DOWN when the last one leaves. The
// third is what makes a query the right home for something like a minted media URL, which
// should exist while someone is looking at the file and not afterwards.

import { test, expect } from './testkit.js';
import { Engine, Provider, Query } from '@3sln/ngin';
import { cell } from '../src/runtime.js';
import * as q from '../src/bl/queries.js';
import { queryOf, keyOfArgs } from '../src/bl/intern.js';
import { watchQuery } from '../src/bl/watchQuery.js';
import { ClearSidecarAction } from '../src/bl/actions.js';

/**
 * Booting a query is asynchronous — it awaits a container lease before `boot` runs — so a
 * subscribe is not live on the next microtask. Every wait here goes through this rather than
 * a bare `await Promise.resolve()`, which passed for a while by accident and then didn't.
 */
const settle = () => new Promise((r) => setTimeout(r, 5));

/** The smallest thing shaped like one of the cell-backed services. */
function service(initial) {
  const c = cell(initial);
  let held = initial;
  // `get`/`observe`/`set` and nothing else — the same surface a slice has, and now the
  // same surface the four remaining services have. A double with a public `state` field
  // was the second door those services still had.
  return {
    get: () => held,
    observe: () => c,
    set(next) { held = next; c.setValue(next); },
  };
}

/**
 * An engine with the resources a query actually leases.
 *
 * Each service is its own provider, as in the app — `static deps = ['explorer']` only means
 * something if there IS an explorer resource. A single `app` provider would make every
 * lease cover everything, which is what this conversion is undoing.
 */
function engineWith(app) {
  const p = app.platform || {};
  const singleton = (v) => Provider.fromSingleton(v ?? {});
  return new Engine({
    providers: {
      app: Provider.fromSingleton(app),
      // Per-engine, keyed by query instance: where a live query keeps its subscription,
      // rather than on the shared instance itself. See bl/queries.js.
      appState: Provider.fromSingleton(app.appState ?? new Map()),

      explorer: singleton(app.explorer),
      search: singleton(app.search),
      transfers: singleton(app.transfers),
      social: singleton(app.social),
      offline: singleton(app.offline),
      activity: singleton(app.activity),
      apiKeys: singleton(app.apiKeys),
      workbench: singleton(p.workbench),
      overlay: singleton(p.overlay),
      settings: singleton(p.settings),
      notifications: singleton(p.notifications),
      context: singleton(p.context),
      commands: singleton(p.commands),
      keybindings: singleton(p.keybindings),
      contributions: singleton(p.contributions),
      viewport: singleton(p.viewport),
      voice: singleton(p.voice),
      api: singleton(p.api),
      // Mirrors bl/index.js: a lazy singleton handing out a CELL that fills in, so leasing
      // it never blocks on the round trip. The one-fetch guarantee is the provider's
      // memoised creation promise, not something a query arranges for itself.
      capabilities: Provider.fromLazySingleton(
        async () => {
          const held = cell(null);
          Promise.resolve(p.api?.capabilities?.()).then((v) => { if (v) held.setValue(v); }, () => {});
          return held;
        },
        () => {},
      ),
      plugins: singleton(p.plugins),
    },
  });
}

test('a query is live: a change reaches every observer', async () => {
  // `search` rather than `explorer`: explorer is a projected VIEW now, so it would be
  // testing the projection as much as the liveness.
  const search = service({ items: [] });
  const engine = engineWith({ search });
  const seen = [];
  const sub = engine.query(q.search).subscribe((v) => seen.push(v));
  await settle();

  search.set({ items: ['a.txt'] });
  await settle();
  expect(seen.length).toBeGreaterThanOrEqual(2);
  expect(seen[0]).toEqual({ items: [] });      // the value that was already true
  expect(seen.at(-1)).toEqual({ items: ['a.txt'] });
  sub.unsubscribe();
});

test('the current value arrives without waiting for the next change', async () => {
  // A subscriber that turns up after the last change should not sit blank until something
  // else happens.
  const search = service({ items: ['already here'] });
  const engine = engineWith({ search });
  const seen = [];
  const sub = engine.query(q.search).subscribe((v) => seen.push(v));
  await settle();
  expect(seen[0]).toEqual({ items: ['already here'] });
  sub.unsubscribe();
});

test('one realization is shared by every observer of the same instance', async () => {
  // The property that makes this cheaper than what it replaces: two components reading the
  // collection list share one subscription rather than each starting their own.
  let boots = 0;
  class Counted extends Query {
    static deps = ['app'];
    boot({ app }, { notify }) {
      boots++;
      notify(app.explorer.get());
      this.off = app.explorer.observe().onDirty(() => notify(app.explorer.get()));
    }
    kill() { this.off?.(); }
  }
  const shared = new Counted();
  const explorer = service({ n: 0 });
  const engine = engineWith({ explorer });

  const a = engine.query(shared).subscribe(() => {});
  const b = engine.query(shared).subscribe(() => {});
  await settle();
  expect(boots).toBe(1);
  a.unsubscribe();
  b.unsubscribe();
});

test('a fresh instance is a second realization, which is why instances are shared', async () => {
  // Recorded as a test because it fails silently in real code: nothing errors, the app just
  // boots a second copy of everything and pays for it forever.
  let boots = 0;
  class Counted extends Query {
    static deps = ['app'];
    boot({ app }, { notify }) { boots++; notify(app.explorer.get()); }
    kill() {}
  }
  const explorer = service({ n: 0 });
  const engine = engineWith({ explorer });
  engine.query(new Counted()).subscribe(() => {});
  engine.query(new Counted()).subscribe(() => {});
  await settle();
  expect(boots).toBe(2);
});

test('it tears down when the last observer leaves, and releases what it held', async () => {
  // The lifecycle a minted URL wants: acquired while someone is looking, released when
  // nobody is. Nothing in a component has to write the teardown.
  let killed = 0;
  class Held extends Query {
    static deps = ['app'];
    boot({ app }, { notify }) { notify('held'); }
    kill() { killed++; }
  }
  const held = new Held();
  const engine = engineWith({ explorer: service({}) });
  const a = engine.query(held).subscribe(() => {});
  const b = engine.query(held).subscribe(() => {});
  await settle();

  a.unsubscribe();
  await settle();
  expect(killed).toBe(0); // b is still watching

  b.unsubscribe();
  await settle();
  expect(killed).toBe(1);
});

// --- the bridge into the render layer ------------------------------------------

test('a query reaches the render layer as a cell', async () => {
  const search = service({ items: [] });
  const engine = engineWith({ search });
  const c = watchQuery(engine, q.search);

  // dodo's Cell protocol, which is what `watch` takes.
  expect(typeof c.onDirty).toBe('function');
  expect(typeof c.getValue).toBe('function');

  let dirty = 0;
  const off = c.onDirty(() => dirty++);
  await settle();
  expect(c.getValue()).toEqual({ items: [] });

  search.set({ items: ['a.txt'] });
  await settle();
  expect(dirty).toBeGreaterThan(0);
  expect(c.getValue()).toEqual({ items: ['a.txt'] });
  off();
});

test('two components watching one query land on one cell', async () => {
  // Otherwise each gets its own subscription and dodo connects the query twice, undoing
  // the sharing ngin just gave us.
  const engine = engineWith({ search: service({}) });
  expect(watchQuery(engine, q.search)).toBe(watchQuery(engine, q.search));
});

test('a parameterised query memoises, so it is not a new realization per render', async () => {
  // `grantsFor(id)` called in a render would otherwise mint a fresh instance every frame —
  // a new live realization each time, none of them shared.
  expect(q.grantsFor('c1')).toBe(q.grantsFor('c1'));
  expect(q.grantsFor('c1')).not.toBe(q.grantsFor('c2'));
});

// --- view queries: plain data, never handles ------------------------------------
//
// The rule these enforce: a query emits a VIEW — descriptions with every decision already
// made — and interaction goes back the other way as an action carrying an id. A query that
// hands out a callable has handed out the service, and the component is reaching around the
// engine again, which is the thing this ticket exists to stop.

/** Anything callable anywhere in the emitted value, with the path that reached it. */
function callablesIn(value, path = '$', seen = new Set()) {
  if (typeof value === 'function') return [path];
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  return Object.entries(value).flatMap(([k, v]) => callablesIn(v, `${path}.${k}`, seen));
}

function platformStub() {
  const contributions = cell([]);
  const context = cell({});
  const settings = cell({});
  const items = [
    { id: 'a', type: 'statusItem', html: '<b>A</b>', slot: 'left', order: 2, name: 'A', command: 'x.run' },
    { id: 'b', type: 'statusItem', html: '<b>B</b>', name: 'B', when: 'nope' },      // when is false
    { id: 'c', type: 'statusItem', html: '<b>C</b>', name: 'C', visible: false },     // hidden
    { id: 'd', type: 'statusItem', name: 'D' },                                       // no html
  ];
  return {
    platform: {
      // The palette view is keyed off what was typed, so the shell slices are part of it.
      overlay: service({ palette: { mode: 'commands', query: '', index: 0 } }),
      workbench: service({ launch: { query: '', index: 0 } }),
      contributions: {
        observe: () => contributions,
        ofType: (t) => items.filter((i) => i.type === t),
        get: (id) => ({ title: `Title of ${id}` }),
      },
      context: { observe: () => context, evaluate: (expr) => expr !== 'nope' },
      settings: { observe: () => settings },
      plugins: null,
      capabilities: { read: true, write: false },
      commands: {
        // A real command carries a handler; the view must not.
        paletteCommands: () => [{ id: 'x.run', title: 'Run it', category: 'Test', when: 'ok', handler() {} }],
        isEnabled: () => true,
        isAvailable: () => true,
      },
      keybindings: {
        // Two commands on one chord, so the view has something to detect a clash from.
        resolved: () => [
          { bindingId: 'x.run|mod+r', command: 'x.run', key: 'mod+r' },
          { bindingId: 'y.go|mod+r', command: 'y.go', key: 'mod+r' },
          { bindingId: 'z.solo|mod+k', command: 'z.solo', key: 'mod+k' },
        ],
        overrides: () => ({ 'z.solo|mod+k': 'mod+k' }),
        labelFor: (c) => (c === 'x.run' ? '⌘R' : null),
      },
    },
    _dirty: { contributions, context },
  };
}

async function readOnce(query, app) {
  const engine = engineWith(app);
  const seen = [];
  const sub = engine.query(query).subscribe((v) => seen.push(v));
  await settle();
  sub.unsubscribe();
  return seen.at(-1);
}

test('the palette command view is a description, not a command', async () => {
  const app = platformStub();
  const list = await readOnce(q.paletteMatches, app);
  expect(list).toEqual([
    { id: 'x.run', title: 'Run it', category: 'Test', icon: null, keybinding: '⌘R', available: true },
  ]);
  // The source command had a `handler`. Emitting it would hand a component a way to run
  // something without going through the engine at all.
  expect(callablesIn(list)).toEqual([]);
  expect('when' in list[0]).toBe(false);
});

test('the status item view resolves when/visibility, so a component does not have to', async () => {
  // This is what let the status bar stop carrying `platform`: it used to call
  // `context.evaluate(item.when)` per item, mid-render.
  const app = platformStub();
  const items = await readOnce(q.statusItems, app);
  expect(items.map((i) => i.id)).toEqual(['a']);   // b: when false, c: hidden, d: no html
  expect(items[0]).toEqual({ id: 'a', slot: 'left', html: '<b>A</b>', tooltip: null, command: 'x.run' });
  expect(callablesIn(items)).toEqual([]);
});

test('the keybinding view names the command rather than carrying it', async () => {
  const app = platformStub();
  const bindings = await readOnce(q.keybindings, app);
  expect(bindings.map((b) => b.command)).toEqual(['x.run', 'y.go', 'z.solo']);
  expect(bindings[0].bindingId).toBe('x.run|mod+r');
  expect(bindings[0].title).toBe('Title of x.run');
  expect(callablesIn(bindings)).toEqual([]);
});

test('the keybinding view flags a clash, which one row cannot see for itself', async () => {
  // Nothing rejects a collision and the LAST registration wins, so binding something onto
  // an occupied chord silently stops the other command working. Spotting it needs the whole
  // list at once — the thing a component rendering one row structurally cannot do.
  const bindings = await readOnce(q.keybindings, platformStub());
  const byCommand = Object.fromEntries(bindings.map((b) => [b.command, b]));
  expect(byCommand['x.run'].clash).toBe(true);
  expect(byCommand['y.go'].clash).toBe(true);
  expect(byCommand['z.solo'].clash).toBe(false);
});

test('the keybinding view says which bindings the user changed', async () => {
  const bindings = await readOnce(q.keybindings, platformStub());
  expect(bindings.find((b) => b.command === 'z.solo').custom).toBe(true);
  expect(bindings.find((b) => b.command === 'x.run').custom).toBe(false);
});

test('capabilities are fetched once, however many regions read them', async () => {
  // Capabilities are ambient facts other things consult, not something anyone asks for, so
  // they are a PROVIDER — see bl/index.js. It hands out a cell that fills in when the
  // server answers, which is what lets a lease of it not block on the round trip.
  //
  // The single fetch is the provider memoising its creation promise. It used to be a query
  // keeping `api.capabilities()` on its own instance, because ngin re-boots a query that is
  // observed again after going idle — a cache with no invalidation living inside a view.
  let calls = 0;
  const app = platformStub();
  app.platform.api = { capabilities: async () => { calls++; return { storageDrivers: ['s3'] }; } };
  const engine = engineWith(app);

  const a = engine.query(q.capabilities).subscribe(() => {});
  const b = engine.query(q.capabilities).subscribe(() => {});
  await settle();
  expect(calls).toBe(1);

  // Away and back: still no second request.
  a.unsubscribe(); b.unsubscribe();
  await settle();
  const seen = [];
  const c = engine.query(q.capabilities).subscribe((v) => seen.push(v));
  await settle();
  expect(calls).toBe(1);
  expect(seen.at(-1)).toEqual({ storageDrivers: ['s3'] });
  c.unsubscribe();
});

test('a view recomputes when a context key flips, not only when its own list changes', async () => {
  // `enabled` and `when` are decided from the context, so a view that only watched the
  // contribution registry would go stale the moment a selection changed — showing a
  // command as available after the thing it acts on was deselected.
  const app = platformStub();
  const engine = engineWith(app);
  const seen = [];
  const sub = engine.query(q.statusItems).subscribe((v) => seen.push(v));
  await settle();
  const before = seen.length;
  app._dirty.context.setValue({ changed: true });
  await settle();
  expect(seen.length).toBeGreaterThan(before);
  sub.unsubscribe();
});

// --- interning ------------------------------------------------------------------
//
// ngin shares a realization by instance identity and looks at neither the class nor the
// fields, so two structurally identical queries are two realizations unless something makes
// them one object. These are the cases where getting that wrong is silent.

class Param extends Query {
  static of = queryOf(Param);
  constructor(...args) { super(); this.args = args; }
  boot(_, { notify }) { notify(this.args); }
  kill() {}
}

test('same arguments is the same instance', () => {
  expect(Param.of('n1')).toBe(Param.of('n1'));
  expect(Param.of('n1')).not.toBe(Param.of('n2'));
});

test('each factory has its own table, so two classes never collide', () => {
  // No shared registry keyed by class, so nothing to key wrongly — including under a
  // minifier that collapses two class names to the same identifier.
  class Other extends Query {
    static of = queryOf(Other);
    constructor(x) { super(); this.x = x; }
    boot(_, { notify }) { notify(this.x); }
    kill() {}
  }
  expect(Other.of('x')).not.toBe(Param.of('x'));
  expect(Other.of('x')).toBeInstanceOf(Other);
});

test('argument types are part of the key', () => {
  expect(Param.of('1')).not.toBe(Param.of(1));
  expect(Param.of(0)).not.toBe(Param.of(false));
  expect(Param.of(null)).not.toBe(Param.of());
});

test('object arguments key by content, in a stable order', () => {
  expect(Param.of({ a: 1, b: 2 })).toBe(Param.of({ b: 2, a: 1 }));
  expect(Param.of({ a: 1 })).not.toBe(Param.of({ a: 2 }));
  expect(Param.of(['a', 'b'])).toBe(Param.of(['a', 'b']));
  expect(Param.of(['a', 'b'])).not.toBe(Param.of(['b', 'a']));
});

test('an argument the default key cannot capture is refused at the call site', () => {
  // A function stringifies to `undefined` in JSON, so two queries taking different callbacks
  // would key identically and silently share one realization — the very bug interning
  // exists to prevent, reintroduced by the fix. Fail loudly instead.
  expect(() => Param.of(() => {})).toThrow(/cannot be part of a sharing key/);
  expect(() => Param.of({ cb: () => {} })).toThrow(/#0\.cb/);
  expect(() => Param.of(Symbol('s'))).toThrow(/cannot be part of a sharing key/);
  expect(() => Param.of(new Date(0))).toThrow(/Date/);
});

test('a key function shares more coarsely than the arguments do', () => {
  // The case it is for: an argument that changes how something is displayed but not what is
  // fetched should not split one realization in two. It also sidesteps the keyable check,
  // since the refused argument never reaches the default key.
  class Coarse extends Query {
    static of = queryOf(Coarse, (id) => id);
    constructor(id, opts) { super(); this.id = id; this.opts = opts; }
    boot(_, { notify }) { notify(this.id); }
    kill() {}
  }
  expect(Coarse.of('n1', { preview: true })).toBe(Coarse.of('n1', { preview: false }));
  expect(Coarse.of('n1', {})).not.toBe(Coarse.of('n2', {}));
  expect(() => Coarse.of('n1', () => {})).not.toThrow();
});

test('interning is what makes one realization, not two', async () => {
  let boots = 0;
  class Counted extends Query {
    static of = queryOf(Counted);
    constructor(id) { super(); this.id = id; }
    boot(_, { notify }) { boots++; notify(this.id); }
    kill() {}
  }
  const engine = engineWith({ explorer: service({}) });
  const a = engine.query(Counted.of('node-1')).subscribe(() => {});
  const b = engine.query(Counted.of('node-1')).subscribe(() => {});
  await settle();
  expect(boots).toBe(1);

  engine.query(Counted.of('node-2')).subscribe(() => {});
  await settle();
  expect(boots).toBe(2);   // a genuinely different question does get its own
  a.unsubscribe(); b.unsubscribe();
});

test('a live query stays interned, which is what makes weak eviction safe', async () => {
  // Entries are WeakRefs swept by a finalizer, and that is only sound because liveness pins
  // the instance: ngin's controller map is a plain Map holding the query as a key, deleted
  // only on teardown. If a live entry could be evicted, the next `of()` would mint a second
  // instance alongside a running one — the exact bug, arriving on a timer. An LRU with a cap
  // would do precisely that.
  class Live extends Query {
    static of = queryOf(Live);
    constructor(id) { super(); this.id = id; }
    boot(_, { notify }) { notify(this.id); }
    kill() {}
  }
  const engine = engineWith({ explorer: service({}) });
  const first = Live.of('pinned');
  const sub = engine.query(first).subscribe(() => {});
  await settle();
  if (global.gc) { global.gc(); await settle(); }
  expect(Live.of('pinned')).toBe(first);
  sub.unsubscribe();
});

test('keyOfArgs is available on its own, for a key built from part of the arguments', () => {
  expect(keyOfArgs('a', 1)).toBe(keyOfArgs('a', 1));
  expect(keyOfArgs('a', 1)).not.toBe(keyOfArgs('a', '1'));
});

test('a subclass inheriting `of` is refused rather than quietly building the parent', () => {
  // `of` captures the class it was declared on, so `Sub.of('x')` would return a Base — the
  // sort of wrong that reads as right at the call site. The factory is a plain function so
  // `this` is the class it was reached through, which is what makes this detectable.
  class Base extends Query {
    static of = queryOf(Base);
    constructor(id) { super(); this.id = id; }
    boot(_, { notify }) { notify(this.id); }
    kill() {}
  }
  class Sub extends Base {}
  expect(Base.of('x')).toBeInstanceOf(Base);
  expect(() => Sub.of('x')).toThrow(/Sub\.of\(\) would build a Base/);

  // A subclass with its own factory is fine, and shares separately.
  class Own extends Base { static of = queryOf(Own); }
  expect(Own.of('x')).toBeInstanceOf(Own);
  expect(Own.of('x')).not.toBe(Base.of('x'));
});

test('a detached factory still works, since passing it around is ordinary', () => {
  // No receiver means `this` is undefined in a module, not a different class — that is not
  // the mistake being guarded, so it must not trip the guard.
  class Loose extends Query {
    static of = queryOf(Loose);
    constructor(id) { super(); this.id = id; }
    boot(_, { notify }) { notify(this.id); }
    kill() {}
  }
  const of = Loose.of;
  expect(of('x')).toBe(Loose.of('x'));
  expect(['a', 'b'].map(Loose.of).length).toBe(2);
});


test('the explorer view resolves the selection, so nothing has to ask how', async () => {
  // Ids alone only match the loaded page of the current collection. The launcher selects
  // rows that came from search across every readable collection, so it hands the nodes over
  // with the ids — and everything downstream reads `selectedNodes` rather than knowing that.
  const onPage = { id: 'a', name: 'a.txt' };
  const fromSearch = { id: 'z', name: 'z.txt' };

  const explorer = service({ items: [onPage], selection: ['a'], selectionNodes: null });
  expect((await readOnce(q.explorer, { explorer })).selectedNodes).toEqual([onPage]);

  // Selected from search: not on the page, so only the carried node can resolve it.
  const viaSearch = service({ items: [onPage], selection: ['z'], selectionNodes: [fromSearch] });
  expect((await readOnce(q.explorer, { explorer: viaSearch })).selectedNodes).toEqual([fromSearch]);

  // And a partial state must not take the whole query down with it.
  const bare = service({ items: [] });
  expect((await readOnce(q.explorer, { explorer: bare })).selectedNodes).toEqual([]);
});

// --- the sidecar's lifecycle ----------------------------------------------------------
//
// Opening a file used to load its conversation through an `effect` in bl/index.js watching
// the nav stack, with a module-scoped `let` for change detection. It is a query keyed by
// node now: ngin dispatches `bootAction` when the first observer arrives and `killAction`
// when the last leaves, so the load and the clear are the query's lifetime rather than a
// change somebody has to notice.

test('the clear is scoped to its node, because kill and boot are not ordered', async () => {
  // Switching from A to B can kill A's query AFTER B's has booted. An unscoped clear would
  // then wipe the sidecar B just asked for — the same race the loading path already guards.
  const social = { get: () => ({ sidecar: { nodeId: 'B' } }), loadSidecar(id) { this.cleared = id; } };
  const engine = engineWith({ social });

  // A's query dies while B is on screen: nothing is cleared.
  await engine.dispatch(new ClearSidecarAction('A')).next(['complete', 'error']);
  expect(social.cleared).toBe(undefined);
  expect(social.get().sidecar.nodeId).toBe('B');

  // B's own query dying does clear it.
  await engine.dispatch(new ClearSidecarAction('B')).next(['complete', 'error']);
  expect(social.cleared).toBe(null);
});

test('the sidecar query views the social slice for its node', async () => {
  const social = service({ sidecar: null });
  social.loadSidecar = () => {};
  const engine = engineWith({ social });
  const seen = [];
  const sub = engine.query(q.sidecarFor('n1')).subscribe((v) => seen.push(v));
  await settle();
  // Whatever the load put there reaches the observer — mutations (a new comment, a tag)
  // flow the same way, because this is a view over the resource rather than a copy.
  social.set({ sidecar: { nodeId: 'n1', comments: [{ id: 'c1' }] } });
  await settle();
  expect(seen.at(-1)?.comments).toEqual([{ id: 'c1' }]);
  sub.unsubscribe();
});

test('asking for the same node twice gives the same query instance', () => {
  // Otherwise two observers of one file would be two realizations, two boots, and two
  // LoadSidecarAction dispatches for the same conversation.
  expect(q.sidecarFor('n1')).toBe(q.sidecarFor('n1'));
  expect(q.sidecarFor('n1')).not.toBe(q.sidecarFor('n2'));
});

test('two engines can observe one query instance without clobbering each other', async () => {
  // Query instances are module-level singletons, interned so the same arguments give back
  // the same object — which is what makes ngin share one realization PER ENGINE. Keeping
  // the subscription on the instance (`this.off`) therefore put per-realization state on
  // something that outlives any one of them: the second boot overwrote the first's
  // unsubscribe, and killing either released the wrong one while the other leaked.
  //
  // It lives in `appState` now, which is a provider — so per engine — keyed by the
  // instance. One entry per realization.
  const searchA = service({ items: ['a'] });
  const searchB = service({ items: ['b'] });
  const engineA = engineWith({ search: searchA });
  const engineB = engineWith({ search: searchB });

  const seenA = []; const seenB = [];
  const subA = engineA.query(q.search).subscribe((v) => seenA.push(v));
  const subB = engineB.query(q.search).subscribe((v) => seenB.push(v));
  await settle();

  // Both are live, each on its own resource.
  searchA.set({ items: ['a', 'a2'] });
  searchB.set({ items: ['b', 'b2'] });
  await settle();
  expect(seenA.at(-1)).toEqual({ items: ['a', 'a2'] });
  expect(seenB.at(-1)).toEqual({ items: ['b', 'b2'] });

  // Killing one must not deafen the other — the bug this shape prevents.
  subA.unsubscribe();
  await settle();
  const beforeB = seenB.length;
  searchB.set({ items: ['b', 'b2', 'b3'] });
  await settle();
  expect(seenB.length).toBeGreaterThan(beforeB);
  expect(seenB.at(-1)).toEqual({ items: ['b', 'b2', 'b3'] });
  subB.unsubscribe();
});

test('a killed query leaves nothing behind in appState', async () => {
  const search = service({ items: [] });
  const state = new Map();
  const engine = engineWith({ search, appState: state });
  const sub = engine.query(q.search).subscribe(() => {});
  await settle();
  expect(state.size).toBe(1);
  sub.unsubscribe();
  await settle();
  // Otherwise every file ever looked at would keep an entry for the life of the page.
  expect(state.size).toBe(0);
});
