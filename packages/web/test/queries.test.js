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
