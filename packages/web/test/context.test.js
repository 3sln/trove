// Context as a registry of cells, and when-clauses as live booleans.
//
// The properties that matter: a key is owned by exactly one thing, and a key can be
// referenced before anything owns it — because a keymap naming a plugin's register is
// parsed long before that plugin installs.
//
// A clause is evaluated against the whole snapshot. There was a per-clause subscription
// layer here — `watch`/`cellFor`/`keysOf` deriving a cell over exactly the keys an
// expression named — and nothing in the app ever called it: the palette, the openers and
// the keybindings all go through `evaluate`. These tests were its only callers, which is
// how a dead mechanism keeps looking alive.

import { test, expect } from './testkit.js';
import { ContextRegistry } from '../src/platform/context.js';
import { evaluateWhen } from '../src/platform/whenclause.js';
import { cell } from '../src/runtime.js';

test('regex flags survive the lexer', () => {
  // `parseRegex` always accepted flags; the token pattern stopped at the closing slash, so
  // `/^H/i` lexed as `/^H/` plus a stray `i`, failed to parse, and compiled to () => false.
  // Every case-insensitive clause was silently dead.
  expect(evaluateWhen('s =~ /^h/', { s: 'hi' })).toBe(true);
  expect(evaluateWhen('s =~ /^H/i', { s: 'hi' })).toBe(true);
  expect(evaluateWhen('s =~ /^H/', { s: 'hi' })).toBe(false);
});

test('a clause can name a key nothing owns yet, and picks it up when something does', () => {
  // A keymap referencing a plugin's register is parsed at install time for the HOST, long
  // before that plugin is installed — and the plugin may later be uninstalled, taking its
  // key with it. Unowned reads as undefined, which every clause already treats as falsy.
  const registry = new ContextRegistry();
  const clause = "trove+contrib:acme.com/docs/busy == 'idle'";
  expect(registry.evaluate(clause)).toBe(false);

  const owned = registry.own('trove+contrib:acme.com/docs/busy', 'idle');
  expect(registry.evaluate(clause)).toBe(true);

  owned.set('working');
  expect(registry.evaluate(clause)).toBe(false);
  owned.set('idle');
  expect(registry.evaluate(clause)).toBe(true);

  // Uninstalled: the clause goes false again rather than holding the last value it saw.
  owned.dispose();
  expect(registry.evaluate(clause)).toBe(false);
});

test('one owner per key, and the writer is the capability', () => {
  const registry = new ContextRegistry();
  const owned = registry.own('demo.key', 1);
  expect(registry.get('demo.key')).toBe(1);
  expect(() => registry.own('demo.key', 2)).toThrow(/already has an owner/);
  owned.set(7);
  expect(registry.get('demo.key')).toBe(7);
  owned.dispose();
  expect(registry.get('demo.key')).toBe(undefined);
});
