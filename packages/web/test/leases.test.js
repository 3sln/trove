// `static deps` is a contract, not a comment.
//
// An action declares what it may reach and ngin builds `resources` from exactly that list.
// Nothing widens the bag afterwards, so a resource an action USES but did not DECLARE is
// `undefined` — and `undefined.set(...)` throws where the code reads as if it cannot.
//
// It had already drifted, and the drift was a live crash. `PickAndInstallPluginAction`
// leased notifications/plugins/social/workbench while the install flow it hands the bag to
// writes `r.overlay.set(...)`, two modules away. `beginInstallFromFile` wraps that call in
// a try/catch, so the user was told "Couldn't read the plugin: Cannot read properties of
// undefined (reading 'set')" — about a file that read perfectly. One missing word.
//
// So the declaration is checked against the code rather than trusted. Under-leasing only:
// a bag handed wholesale to a helper is legitimate, and "declared but not used in this
// body" is not evidence of anything.
//
// The bag is followed ACROSS functions, because that is where the bug lived — `execute(r)`
// → `beginInstallFromFile(r, file)` → `review({ notifications, overlay, … }, pkg)`. A
// checker that only read the action's own body would have passed the code it exists for.

import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
const read = (p) => readFileSync(join(SRC, p), 'utf8');

/** Blank comments and string bodies, preserving offsets so line numbers stay true. */
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

/** From an opening bracket to the index just past its match. */
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

function sources(dir = '') {
  const out = [];
  for (const e of readdirSync(join(SRC, dir), { withFileTypes: true })) {
    const p = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** The resource names the engine actually offers, read from the provider map. */
function resourceNames() {
  const src = code(read('bl/index.js'));
  const at = src.indexOf('providers: {');
  const body = src.slice(at + 'providers: '.length);
  const map = body.slice(1, matchBracket(body, 0) - 1);
  const names = new Set();
  for (let i = 0; i < map.length; i++) {
    if ('{(['.includes(map[i])) { i = matchBracket(map, i) - 1; continue; }
    const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(map.slice(i));
    if (m && (i === 0 || /[\s,]/.test(map[i - 1]))) { names.add(m[1]); i += m[0].length - 1; }
  }
  return names;
}

/** Split a parameter list on top-level commas. */
function params(list) {
  const out = [];
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if ('{(['.includes(list[i])) { i = matchBracket(list, i) - 1; continue; }
    if (list[i] === ',') { out.push(list.slice(start, i).trim()); start = i + 1; }
  }
  const last = list.slice(start).trim();
  if (last) out.push(last);
  return out;
}

/** Top-level names bound by a `{ a, b: c, ...rest }` pattern. */
function patternNames(pattern) {
  const inner = pattern.slice(pattern.indexOf('{') + 1, matchBracket(pattern, pattern.indexOf('{')) - 1);
  return params(inner)
    .map((p) => /^([A-Za-z_$][\w$]*)/.exec(p.replace(/^\.\.\./, ''))?.[1])
    .filter(Boolean);
}

/**
 * Every function in the package that could receive a resource bag, indexed by name.
 *
 * `function f(...)`, `const f = (...) =>`, and class methods alike — a bag reaches all
 * three. Overloading a name across modules would make this ambiguous; the package does not,
 * and a duplicate would show up as a bag requirement appearing where it does not belong
 * rather than as a silent miss.
 */
function functionTable() {
  const table = new Map();
  for (const file of sources()) {
    const src = code(read(file));
    const decl = /(?:^|[\s;=({[,])(?:async\s+)?(?:function\s*\*?\s*)?([A-Za-z_$][\w$]*)\s*(\()/g;
    for (const m of src.matchAll(decl)) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(src, open);
      // Only a definition has a body; a call site does not.
      const after = src.slice(close).match(/^\s*(=>\s*)?\{/);
      if (!after) continue;
      const bodyAt = src.indexOf('{', close);
      if (table.has(m[1])) { table.set(m[1], null); continue; } // ambiguous — do not follow
      table.set(m[1], {
        file,
        params: params(src.slice(open + 1, close - 1)),
        body: src.slice(bodyAt, matchBracket(src, bodyAt)),
      });
    }
  }
  return table;
}

/**
 * The resource names a function body requires of the bag it was handed as `param`.
 *
 * Direct reads (`r.notifications`, or the names a `{ … }` parameter binds), plus whatever
 * the functions it forwards the bag to require of it. `this.m(r)` is not followed: the
 * method is virtual and the subclass that implements it declares its own leases, so it is
 * checked in its own right rather than through its caller.
 */
function requires(fn, index, table, resources, seen = new Set()) {
  if (!fn || index >= fn.params.length) return new Set();
  const key = `${fn.file}:${fn.params.join(',')}:${index}`;
  if (seen.has(key)) return new Set();
  seen.add(key);

  const param = fn.params[index];
  if (param.startsWith('{')) return new Set(patternNames(param).filter((n) => resources.has(n)));

  const bag = /^([A-Za-z_$][\w$]*)/.exec(param)?.[1];
  if (!bag) return new Set();
  const out = new Set();
  for (const [, name] of fn.body.matchAll(new RegExp(`\\b${bag}\\.([A-Za-z_$][\\w$]*)`, 'g'))) {
    if (resources.has(name)) out.add(name);
  }
  // Forwarded whole: `beginInstallFromFile(r, file)`.
  for (const m of fn.body.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const callee = table.get(m[1]);
    if (!callee || m[1] === bag) continue;
    const open = m.index + m[0].length - 1;
    const args = params(fn.body.slice(open + 1, matchBracket(fn.body, open) - 1));
    const at = args.findIndex((a) => a.trim() === bag);
    if (at < 0) continue;
    for (const n of requires(callee, at, table, resources, seen)) out.add(n);
  }
  return out;
}

/**
 * `class X extends Y {` → its own `static deps`, or its nearest ancestor's.
 *
 * The list is read from the RAW source: `code()` blanks string bodies, and `static deps`
 * is a list of strings — reading it from the blanked copy answers "leases nothing" for
 * every action in the package, which is a checker that fails on everything and is
 * therefore switched off within the day.
 */
function actionClasses(src, raw) {
  const found = [];
  for (const m of src.matchAll(/class\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$]*)\s*\{/g)) {
    const open = src.indexOf('{', m.index + m[0].length - 1);
    const body = src.slice(open, matchBracket(src, open));
    const declared = /static\s+deps\s*=\s*\[([^\]]*)\]/.exec(raw.slice(open, open + body.length));
    found.push({
      name: m[1],
      base: m[2],
      body,
      at: src.slice(0, m.index).split('\n').length,
      deps: declared ? [...declared[1].matchAll(/'([^']+)'/g)].map((d) => d[1]) : null,
    });
  }
  const byName = new Map(found.map((c) => [c.name, c]));
  for (const c of found) {
    let hop = c;
    while (hop && hop.deps === null) hop = byName.get(hop.base);
    c.effective = new Set(hop?.deps || []);
  }
  return found;
}

test('every resource an action uses is one it leased', () => {
  const resources = resourceNames();
  // If the derivation breaks this would pass by checking nothing.
  expect(resources.has('overlay') && resources.has('notifications')).toBe(true);
  const table = functionTable();

  const bad = [];
  for (const file of sources()) {
    const raw = read(file);
    const src = code(raw);
    if (!/extends\s+(?:Action|\w*Action)\s*\{/.test(src)) continue;
    for (const cls of actionClasses(src, raw)) {
      if (!cls.deps && !cls.effective.size) continue;
      // Every method that takes a bag: `execute(r)`, `execute({a, b})`, `withValue(v, r)`.
      for (const m of cls.body.matchAll(/(?:^|[\s;}])(?:async\s+)?([A-Za-z_$][\w$]*)\s*(\()/g)) {
        if (m[1] === 'constructor' || m[1] === 'if' || m[1] === 'for' || m[1] === 'while') continue;
        const open = m.index + m[0].length - 1;
        const close = matchBracket(cls.body, open);
        if (!/^\s*\{/.test(cls.body.slice(close))) continue;
        const bodyAt = cls.body.indexOf('{', close);
        const fn = {
          file,
          params: params(cls.body.slice(open + 1, close - 1)),
          body: cls.body.slice(bodyAt, matchBracket(cls.body, bodyAt)),
        };
        for (let i = 0; i < fn.params.length; i++) {
          const p = fn.params[i];
          const isBag = p.startsWith('{')
            ? patternNames(p).some((n) => resources.has(n))
            : /^(r|resources)\b/.test(p);
          if (!isBag) continue;
          for (const need of requires(fn, i, table, resources)) {
            if (cls.effective.has(need)) continue;
            bad.push(`${file}:${cls.at}  ${cls.name}.${m[1]}() uses "${need}" — not in static deps [${[...cls.effective].join(', ')}]`);
          }
        }
      }
    }
  }
  expect(bad).toEqual([]);
});
