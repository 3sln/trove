// Context as a registry of cells, and when-clauses as live booleans.
//
// The properties that matter: a key is owned by exactly one thing, a clause depends on
// exactly the keys it names, and a key can be referenced before anything owns it —
// because a keymap naming a plugin's register is parsed long before that plugin installs.

import { test, expect } from './testkit.js';
import { ContextRegistry } from '../src/platform/context.js';
import { keysOf, evaluateWhen } from '../src/platform/whenclause.js';
import { cell, readCell } from '../src/runtime.js';

const read = (c) => { const off = c.onDirty(() => {}); const v = readCell(c); off(); return v; };

test('a clause depends on the keys it names and nothing else', () => {
  expect(keysOf("view.active == 'home' && explorer.hasSelection"))
    .toEqual(['view.active', 'explorer.hasSelection']);
  // A plugin register is addressed by its full contribution URI, which the lexer has a
  // dedicated alternative for — a URI's slashes would otherwise open a /…/ literal and
  // swallow the rest of the expression.
  expect(keysOf("trove+contrib:acme.com/docs/busy == 'idle'"))
    .toEqual(['trove+contrib:acme.com/docs/busy']);
  // Literals name nothing, so a constant clause derives over nothing.
  expect(keysOf("'x' == 'x'")).toEqual([]);
  // Neither does one that could not be parsed — watching it must yield a settled false,
  // not a cell that never resolves.
  expect(keysOf('&& &&')).toEqual([]);
});

test('regex flags survive the lexer', () => {
  // `parseRegex` always accepted flags; the token pattern stopped at the closing slash, so
  // `/^H/i` lexed as `/^H/` plus a stray `i`, failed to parse, and compiled to () => false.
  // Every case-insensitive clause was silently dead.
  expect(evaluateWhen('s =~ /^h/', { s: 'hi' })).toBe(true);
  expect(evaluateWhen('s =~ /^H/i', { s: 'hi' })).toBe(true);
  expect(evaluateWhen('s =~ /^H/', { s: 'hi' })).toBe(false);
});

test('a watched clause tracks the keys it names', () => {
  const registry = new ContextRegistry();
  const active = cell('home');
  const selected = cell(false);
  registry.register('view.active', active);
  registry.register('explorer.hasSelection', selected);

  const live = registry.watch("view.active == 'home' && explorer.hasSelection");
  expect(read(live)).toBe(false);
  selected.setValue(true);
  expect(read(live)).toBe(true);
  active.setValue('settings');
  expect(read(live)).toBe(false);
});

test('a clause can name a key nothing owns yet, and picks it up when something does', () => {
  // The reason slots exist. A keymap referencing a plugin's register is parsed at install
  // time for the HOST, long before that plugin is installed — and the plugin may later be
  // uninstalled, taking its key with it.
  const registry = new ContextRegistry();
  const live = registry.watch("trove+contrib:acme.com/docs/busy == 'idle'");
  expect(read(live)).toBe(false); // unowned reads undefined, which is falsy

  const owned = registry.own('trove+contrib:acme.com/docs/busy', 'idle');
  expect(read(live)).toBe(true);

  owned.set('working');
  expect(read(live)).toBe(false);
  owned.set('idle');
  expect(read(live)).toBe(true);

  // Uninstalled: the clause goes false again rather than holding the last value it saw.
  owned.dispose();
  expect(read(live)).toBe(false);
});

test('a clause is not recomputed by a key it does not name', () => {
  const registry = new ContextRegistry();
  const active = cell('home');
  const unrelated = cell(0);
  registry.register('view.active', active);
  registry.register('noise', unrelated);

  let recomputes = 0;
  const live = registry.watch("view.active == 'home'");
  const off = live.onDirty(() => { recomputes++; });
  readCell(live);

  unrelated.setValue(1);
  unrelated.setValue(2);
  expect(recomputes).toBe(0); // the whole point: the palette stops re-running every clause

  active.setValue('settings');
  expect(recomputes).toBe(1);
  off();
});

test('one owner per key, and the writer is the capability', () => {
  const registry = new ContextRegistry();
  const owned = registry.own('demo.key', 1);
  expect(registry.get('demo.key')).toBe(1);
  expect(() => registry.own('demo.key', 2)).toThrow(/already has an owner/);
  owned.set(7);
  expect(registry.get('demo.key')).toBe(7);
  owned.dispose();
  expect(registry.has('demo.key')).toBe(false);
});
