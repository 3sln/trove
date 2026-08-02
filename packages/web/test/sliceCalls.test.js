// Slice-backed resources only answer the slice API.
//
// F3 dissolved WorkbenchService, a 17-method facade that forwarded to navigation, overlay
// and a state bag. `workbench` became a plain slice — `observe/get/set/replace` and nothing
// else — and three call sites kept calling methods only the facade had:
//
//   r.workbench.closeTab(id)            delete, on a file that was open
//   r.workbench.updateTabNode(node)     every rename
//   workbench.setLaunchQuery(text)      voice search
//
// All three are a TypeError the moment they run, and all three were invisible: the bundler
// treats a property access as fine, `bun test` never dispatched them with a subject, and the
// boot smoke test dispatches every command with an EMPTY selection — which is exactly the
// path that returns before reaching the bad line. Rename reported "Couldn't rename:
// A.workbench.updateTabNode is not a function" in a toast, and delete managed to report
// success and failure at once.
//
// So: check the shape statically. A slice's whole API is four methods, which makes "is this
// call answerable" decidable by reading, and makes the next facade removal fail here rather
// than in a toast. The slice-backed names are DERIVED from the source rather than listed, so
// promoting a slice to a service (or the reverse) does not silently switch the check off.

import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
const SLICE_API = new Set(['observe', 'get', 'set', 'replace']);

const read = (p) => readFileSync(join(SRC, p), 'utf8');

/**
 * Blank out comments and string bodies, preserving offsets so reported line numbers stay
 * true. This file's own subject matter lives mostly in prose — the comment above every
 * fixed call site names `workbench.closeTab()` — and a checker that reads its own
 * explanation as a violation is a checker nobody keeps.
 */
function code(src) {
  const out = src.split('');
  const blank = (i, j) => { for (let k = i; k < j; k++) if (out[k] !== '\n') out[k] = ' '; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const j = e < 0 ? src.length : e + 2; blank(i, j); i = j - 1; }
    else if (c === '/' && d === '/') { let j = src.indexOf('\n', i); if (j < 0) j = src.length; blank(i, j); i = j - 1; }
    else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      blank(i + 1, Math.min(j, src.length));
      i = j;
    }
  }
  return out.join('');
}

/** The `xState = () => slice({...})` factories. */
function sliceFactories() {
  const src = read('bl/state.js');
  return new Set([...src.matchAll(/export const (\w+)\s*=\s*\([^)]*\)\s*=>\s*slice\(/g)].map((m) => m[1]));
}

/** From `at`, which must be an opening bracket, to its match. Returns the index after it. */
function matchBracket(src, at) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [pairs[src[at]]];
  let i = at + 1;
  for (; i < src.length && stack.length; i++) {
    if (pairs[src[i]]) stack.push(pairs[src[i]]);
    else if (src[i] === stack[stack.length - 1]) stack.pop();
  }
  return i;
}

/**
 * The TOP-LEVEL keys of an object literal body — nested objects and arrays skipped whole,
 * so `{ a: { b: 1 } }` is `['a']`. Computed and spread keys are not names and are ignored;
 * a slice that takes one is dynamic in that position and the check has nothing to say.
 */
function literalKeys(body) {
  const keys = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i])) i++;
    const rest = body.slice(i);
    const named = /^([A-Za-z_$][\w$]*)\s*:/.exec(rest) || /^([A-Za-z_$][\w$]*)\s*(?=[,}]|$)/.exec(rest);
    if (named) { keys.push(named[1]); i += named[0].length; }
    // Skip this entry's VALUE to the next top-level comma — otherwise a ternary reads as
    // another key (`error: n ? null : msg` looked like a key called `null`).
    while (i < body.length && body[i] !== ',') {
      i = '{[('.includes(body[i]) ? matchBracket(body, i) : i + 1;
    }
  }
  return keys;
}

/** Factory name → the keys its initializer declares. */
function declaredKeys() {
  const src = code(read('bl/state.js'));
  const out = new Map();
  for (const m of src.matchAll(/export const (\w+)\s*=\s*\([^)]*\)\s*=>\s*slice\(/g)) {
    const open = src.indexOf('{', m.index + m[0].length - 1);
    const close = matchBracket(src, open);
    out.set(m[1], new Set(literalKeys(src.slice(open + 1, close - 1))));
  }
  return out;
}

/** Provider key → the factory behind it, by the same two hops as above. */
function sliceBackedFactories() {
  const factories = sliceFactories();
  const src = read('bl/index.js');
  const locals = new Map();
  for (const [, name, fn] of src.matchAll(/const (\w+)\s*=\s*(\w+)\(/g)) {
    if (factories.has(fn)) locals.set(name, fn);
    else if (factories.has(fn.replace(/Slice$/, ''))) locals.set(name, fn.replace(/Slice$/, ''));
  }
  const out = new Map();
  for (const [, key, varName] of src.matchAll(/(\w+):\s*Provider\.fromSingleton\((\w+)\)/g)) {
    if (locals.has(varName)) out.set(key, locals.get(varName));
  }
  return out;
}

/**
 * Provider keys whose singleton came from one of those factories.
 *
 * Two hops, because the provider table names a local: `const workbench = workbenchState()`
 * then `workbench: Provider.fromSingleton(workbench)`. The local may be renamed on the way
 * in (`viewState` comes from `viewStateSlice`), so the second hop is by variable, not by key.
 */
function sliceBackedResources() {
  const factories = sliceFactories();
  const src = read('bl/index.js');
  const locals = new Set(
    [...src.matchAll(/const (\w+)\s*=\s*(\w+)\(/g)]
      .filter(([, , fn]) => factories.has(fn) || factories.has(fn.replace(/Slice$/, '')))
      .map(([, name]) => name),
  );
  return new Set(
    [...src.matchAll(/(\w+):\s*Provider\.fromSingleton\((\w+)\)/g)]
      .filter(([, , varName]) => locals.has(varName))
      .map(([, key]) => key),
  );
}

/** Every .js file under src/, so a call site cannot hide by moving. */
function sources(dir = '') {
  const out = [];
  for (const e of readdirSync(join(SRC, dir), { withFileTypes: true })) {
    const p = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('slice-backed resources are only ever called through the slice API', () => {
  const slices = sliceBackedResources();
  // If the derivation breaks, the test would pass by checking nothing. Assert it found the
  // shell slices this exists to protect.
  expect([...slices].sort()).toEqual(expect.arrayContaining(['overlay', 'search', 'workbench']));

  const bad = [];
  for (const file of sources()) {
    const raw = read(file);
    const src = code(raw);
    const lines = raw.split('\n');
    for (const name of slices) {
      // `r.workbench.foo(` / `resources.workbench.foo(` and the destructured `workbench.foo(`.
      const re = new RegExp(`\\b(?:r\\.|resources\\.)?${name}\\.(\\w+)\\s*\\(`, 'g');
      for (const m of src.matchAll(re)) {
        if (SLICE_API.has(m[1])) continue;
        const line = src.slice(0, m.index).split('\n').length;
        bad.push(`${file}:${line}  ${name}.${m[1]}()  —  ${lines[line - 1].trim()}`);
      }
    }
  }
  expect(bad).toEqual([]);
});

// And the other half of the same promise. `set` merges ANYTHING, so a key written but
// never declared is silent: `explorerState` never mentioned `selectionNodes`, yet it was
// the primary read path in `selectedNodesOf` — the very function written to end the class
// of bug where rename/trash/copy-link returned quietly while `hasSelection` disagreed.
// `searchState` never mentioned `filtered`, `offline` or `resolved`, and `resolved` drives
// `pickView`. state.js presents the initializer as the documentation of what a slice is,
// so someone reading it to find out got a wrong answer, and nothing said so.
test('every key written to a slice is declared in its initializer', () => {
  const backing = sliceBackedFactories();
  const declared = declaredKeys();
  expect(backing.size).toBeGreaterThan(4);

  const bad = [];
  for (const file of sources()) {
    const raw = read(file);
    const src = code(raw);
    const lines = raw.split('\n');
    for (const [name, factory] of backing) {
      const keys = declared.get(factory);
      // A slice that declares NO keys is declaring that its keys are dynamic — `viewState`
      // is keyed by component, so there is no fixed set to check against.
      if (!keys || !keys.size) continue;
      const re = new RegExp(`\\b(?:r\\.|resources\\.)?${name}\\.(?:set|replace)\\s*\\(\\s*\\{`, 'g');
      for (const m of src.matchAll(re)) {
        const open = m.index + m[0].length - 1;
        const written = literalKeys(src.slice(open + 1, matchBracket(src, open) - 1));
        for (const key of written) {
          if (keys.has(key)) continue;
          const line = src.slice(0, m.index).split('\n').length;
          bad.push(`${file}:${line}  ${name}.set({ ${key}: … })  —  ${lines[line - 1].trim()}`);
        }
      }
    }
  }
  expect(bad).toEqual([]);
});

// No resource keeps a public, writable copy of its value.
//
// bl/state.js names the problem and claimed it fixed: "TWO DOORS. Actions read `.state` and
// queries read `.cell`, and the two are only equal by habit… A slice has one value and one
// way to read it." Five reads in actions.js still went through `.state`, because the four
// resources that stayed services never got a `get()` — and `state` was a PUBLIC field, one
// typo from `social.state.sidecar = null` writing the value while notifying nobody.
//
// Two halves, because the resources are two shapes. A class whose cell carries one plain
// value holds it privately and answers `get()`, which is what makes SLICE_API the contract
// for slices and services alike. A keyed registry is not that shape — `context.get(key)`,
// `settings.get(key)` and `contributions.get(uri)` are reads OF something rather than reads
// of everything — so for those only the first half applies. Adding a no-arg `get()` beside
// a keyed one would be a worse ambiguity than the one being removed.
test('no resource keeps a public, writable copy of its value', () => {
  const classes = new Map();
  for (const file of sources()) {
    const raw = read(file);
    for (const m of code(raw).matchAll(/export class ([A-Za-z_$][\w$]*)\s*\{/g)) {
      const open = m.index + m[0].length - 1;
      classes.set(`${file}:${m[1]}`, raw.slice(open, matchBracket(raw, open)));
    }
  }
  // If the class scan breaks this would pass by checking nothing.
  expect([...classes.keys()].some((k) => k.endsWith(':OfflineService'))).toBe(true);

  const bad = [];
  for (const [name, body] of classes) {
    const cellBacked = /\bobserve\s*\(\s*\)\s*\{/.test(body);
    if (cellBacked && /\bthis\.state\s*=/.test(body)) {
      bad.push(`${name} writes a public this.state beside its cell — use #state`);
    }
    if (/#state\b/.test(body) && !/(^|\s)get\s*\(\s*\)\s*\{/m.test(body)) {
      bad.push(`${name} holds #state but offers no get()`);
    }
  }
  expect(bad).toEqual([]);
});
