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

/**
 * Booting a query is asynchronous — it awaits a container lease before `boot` runs — so a
 * subscribe is not live on the next microtask. Every wait here goes through this rather than
 * a bare `await Promise.resolve()`, which passed for a while by accident and then didn't.
 */
const settle = () => new Promise((r) => setTimeout(r, 5));

/** The smallest thing shaped like one of the cell-backed services. */
function service(initial) {
  const c = cell(initial);
  return {
    state: initial,
    observe: () => c,
    set(next) { this.state = next; c.setValue(next); },
  };
}

function engineWith(app) {
  return new Engine({ providers: { app: Provider.fromSingleton(app) } });
}

test('a query is live: a change reaches every observer', async () => {
  const explorer = service({ items: [] });
  const engine = engineWith({ explorer });
  const seen = [];
  const sub = engine.query(q.explorer).subscribe((v) => seen.push(v));
  await settle();

  explorer.set({ items: ['a.txt'] });
  await settle();
  expect(seen.length).toBeGreaterThanOrEqual(2);
  expect(seen[0]).toEqual({ items: [] });      // the value that was already true
  expect(seen.at(-1)).toEqual({ items: ['a.txt'] });
  sub.unsubscribe();
});

test('the current value arrives without waiting for the next change', async () => {
  // A subscriber that turns up after the last change should not sit blank until something
  // else happens.
  const explorer = service({ items: ['already here'] });
  const engine = engineWith({ explorer });
  const seen = [];
  const sub = engine.query(q.explorer).subscribe((v) => seen.push(v));
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
      notify(app.explorer.state);
      this.off = app.explorer.observe().onDirty(() => notify(app.explorer.state));
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
    boot({ app }, { notify }) { boots++; notify(app.explorer.state); }
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
  const explorer = service({ items: [] });
  const engine = engineWith({ explorer });
  const c = watchQuery(engine, q.explorer);

  // dodo's Cell protocol, which is what `watch` takes.
  expect(typeof c.onDirty).toBe('function');
  expect(typeof c.getValue).toBe('function');

  let dirty = 0;
  const off = c.onDirty(() => dirty++);
  await settle();
  expect(c.getValue()).toEqual({ items: [] });

  explorer.set({ items: ['a.txt'] });
  await settle();
  expect(dirty).toBeGreaterThan(0);
  expect(c.getValue()).toEqual({ items: ['a.txt'] });
  off();
});

test('two components watching one query land on one cell', async () => {
  // Otherwise each gets its own subscription and dodo connects the query twice, undoing
  // the sharing ngin just gave us.
  const engine = engineWith({ explorer: service({}) });
  expect(watchQuery(engine, q.explorer)).toBe(watchQuery(engine, q.explorer));
});

test('a parameterised query memoises, so it is not a new realization per render', async () => {
  // `contributionsOfType('statusItem')` called in a render would otherwise mint a fresh
  // instance every frame — a new live realization each time, none of them shared.
  expect(q.contributionsOfType('statusItem')).toBe(q.contributionsOfType('statusItem'));
  expect(q.contributionsOfType('statusItem')).not.toBe(q.contributionsOfType('opener'));
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
      },
      keybindings: {
        resolved: () => [{ command: 'x.run', key: 'mod+r' }],
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
  const list = await readOnce(q.paletteCommands, app);
  expect(list).toEqual([
    { id: 'x.run', title: 'Run it', category: 'Test', icon: null, keybinding: '⌘R', enabled: true },
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
  expect(bindings).toEqual([
    { command: 'x.run', key: 'mod+r', label: '⌘R', title: 'Title of x.run', when: null },
  ]);
  expect(callablesIn(bindings)).toEqual([]);
});

test('capabilities are a copy, so a view cannot grant itself one', async () => {
  const app = platformStub();
  const caps = await readOnce(q.capabilities, app);
  expect(caps).toEqual({ read: true, write: false });
  expect(caps).not.toBe(app.platform.capabilities);
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

test('contributionsOfType shares through queryOf rather than its own memo table', () => {
  expect(q.contributionsOfType('statusItem')).toBe(q.contributionsOfType('statusItem'));
  expect(q.contributionsOfType('statusItem')).not.toBe(q.contributionsOfType('opener'));
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
