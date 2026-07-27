// Every route declares what it touches — and the declarations stay honest.
//
// This exists because getting one wrong is not a crash. Several guards in the
// route layer stand down when a service is switched off:
//
//   if (!ctx.plugins) return;   // plugin service disabled → nothing to check
//
// which is right for a service an operator turned off, and catastrophic for one
// that is merely undeclared: the check does not fail, it silently passes.
// Exactly that happened when these declarations were first written — the
// ownership check on contributor namespaces became a no-op, and two tests caught
// it only because they happened to cover that path.
//
// Two things stop it recurring. At runtime the router hands each handler a bag
// that THROWS on an undeclared name the container could have provided. And here,
// statically, so a route added later cannot quietly under-declare on a path no
// test covers.

import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.resolve(import.meta.dir, '../src/routes.js'), 'utf8');

const RESOURCES = [
  'vfs', 'collections', 'kv', 'sqlite', 'plugins', 'tasks', 'issues', 'sidecar',
  'notifications', 'identity', 'search', 'storage', 'metadata', 'auth', 'push',
  'backgroundWork',
];

// Bounded by the next declaration rather than by counting brackets. Counting is
// what a parser does, and this is not one: `h.startsWith('[')` in routes.js has
// an unbalanced bracket inside a string literal, which is enough to throw a
// naive counter off by one for the rest of the file.
const TOP_LEVEL = /^(?:async function |function |const |export |\})/m;

function declBody(src, from) {
  const rest = src.slice(from);
  const next = rest.slice(1).search(TOP_LEVEL);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

// Comments are stripped first. The prose between routes discusses `ctx.tasks`
// and friends by name, and a mention in a paragraph is not a use — attributing
// it to whichever route happens to precede it is how a static check starts
// reporting things that are not true.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const reads = (body) => RESOURCES.filter((r) => new RegExp(`\\bctx\\.${r}\\b`).test(code(body)));

/** Helper name → the resources it reaches for, including through other helpers. */
function helperClosure() {
  const bodies = new Map();
  for (const m of SRC.matchAll(/^(?:async )?function (\w+)\(/gm)) {
    bodies.set(m[1], declBody(SRC, m.index));
  }
  for (const m of SRC.matchAll(/^const (\w+) = \(ctx\) =>/gm)) {
    bodies.set(m[1], declBody(SRC, m.index));
  }
  const closure = new Map();
  const resolveOne = (name, seen = new Set()) => {
    if (closure.has(name)) return closure.get(name);
    if (seen.has(name) || !bodies.has(name)) return [];
    seen.add(name);
    const found = new Set(reads(bodies.get(name)));
    for (const other of bodies.keys()) {
      if (other !== name && new RegExp(`\\b${other}\\(`).test(code(bodies.get(name)))) {
        for (const d of resolveOne(other, seen)) found.add(d);
      }
    }
    const list = [...found];
    closure.set(name, list);
    return list;
  };
  for (const name of bodies.keys()) resolveOne(name);
  return closure;
}

/** Each route: its declared deps, and what its body actually reaches for. */
function routes() {
  const closure = helperClosure();
  const out = [];
  // Each registration runs until the next one starts.
  const starts = [...SRC.matchAll(/\n {2}r\.(get|post|put|delete)\('([^']+)', (\[[^\]]*\])?/g)];
  for (const [n, m] of starts.entries()) {
    // The last one ends where createRouter does, not at the end of the file —
    // otherwise it swallows every helper below and appears to use everything.
    const endOfRouter = SRC.indexOf('\n}', m.index);
    const reg = code(SRC.slice(m.index, starts[n + 1]?.index ?? endOfRouter));
    const declared = m[3] ? [...m[3].matchAll(/'([^']+)'/g)].map((d) => d[1]) : null;

    const used = new Set(reads(reg));
    const destructured = reg.match(/\(\s*\{([^}]*)\}\s*\)\s*=>/)?.[1]
      || reg.match(/const \{([^}]*)\} = ctx/)?.[1] || '';
    for (const name of destructured.match(/\w+/g) || []) {
      if (RESOURCES.includes(name)) used.add(name);
    }
    for (const [helper, needs] of closure) {
      if (needs.length && new RegExp(`\\b${helper}\\(`).test(reg)) needs.forEach((d) => used.add(d));
    }
    out.push({ route: `${m[1].toUpperCase()} ${m[2]}`, declared, used: [...used] });
  }
  return out;
}

test('the route table was parsed, so the checks below mean something', () => {
  const all = routes();
  expect(all.length).toBeGreaterThan(50);
  expect(all.map((r) => r.route)).toContain('GET /api/items');
});

test('every route declares a dependency list', () => {
  const missing = routes().filter((r) => r.declared === null).map((r) => r.route);
  expect(missing).toEqual([]);
});

test('no route reaches for something it did not declare', () => {
  const under = routes()
    .map((r) => ({ route: r.route, missing: r.used.filter((u) => !r.declared?.includes(u)) }))
    .filter((r) => r.missing.length);
  expect(under).toEqual([]);
});

test('no route declares something it never uses', () => {
  // Over-declaring is harmless at runtime, which is why it needs saying here:
  // a dependency list that drifts into a wish list stops describing the route.
  const over = routes()
    .map((r) => ({ route: r.route, unused: (r.declared || []).filter((d) => !r.used.includes(d)) }))
    .filter((r) => r.unused.length);
  expect(over).toEqual([]);
});

test('the analysis can actually fail — a helper\'s reach is followed', () => {
  // `assertContributorOwned` reads ctx.plugins and nothing else does on that
  // route, so if helper closure were not computed this list would be empty and
  // the under-declaration test above would pass vacuously.
  const closure = helperClosure();
  expect(closure.get('assertContributorOwned')).toEqual(['plugins']);
  expect(closure.get('nodeWithCap').sort()).toEqual(['collections', 'vfs']);
});
