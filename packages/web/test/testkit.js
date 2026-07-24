// A tiny test facade that runs the same web-targeted test file under BOTH
// `bun test` (Node/Bun) and `@web/test-runner` (a real browser, via mocha) — no
// Jest-vs-chai rewrite, no duplicated suites. Web tests import { test, expect }
// from here instead of from 'bun:test'.
//
// Under Bun we defer to bun:test. In the browser we map `test` to mocha's global
// `it` and provide a small jest-style `expect` covering the matchers these suites
// use. The `bun:test` specifier is assembled at runtime so browser bundlers/
// resolvers never try to resolve it.

let test;
let expect;

if (typeof Bun !== 'undefined') {
  const spec = 'bun:' + 'test';
  ({ test, expect } = await import(spec));
} else {
  test = (name, fn) => globalThis.it(name, fn);
  expect = makeExpect;
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual(a[k], b[k]));
}

function fail(msg) {
  throw new Error(msg);
}

function makeExpect(received) {
  const check = (pass, msg) => { if (!pass) fail(msg); };
  const matchers = {
    toBe: (exp) => check(Object.is(received, exp), `expected ${fmt(received)} to be ${fmt(exp)}`),
    toEqual: (exp) => check(deepEqual(received, exp), `expected ${fmt(received)} to equal ${fmt(exp)}`),
    toBeTruthy: () => check(!!received, `expected ${fmt(received)} to be truthy`),
    toBeFalsy: () => check(!received, `expected ${fmt(received)} to be falsy`),
    toBeDefined: () => check(received !== undefined, `expected value to be defined`),
    toBeGreaterThan: (n) => check(received > n, `expected ${fmt(received)} > ${fmt(n)}`),
    toContain: (sub) => check(received != null && received.includes(sub), `expected ${fmt(received)} to contain ${fmt(sub)}`),
    toThrow: (matcher) => {
      let threw = false;
      let err;
      try { received(); } catch (e) { threw = true; err = e; }
      check(threw, 'expected function to throw');
      if (matcher instanceof RegExp) check(matcher.test(err?.message ?? ''), `expected error ${fmt(err?.message)} to match ${matcher}`);
      else if (typeof matcher === 'string') check((err?.message ?? '').includes(matcher), `expected error to include ${fmt(matcher)}`);
    },
  };
  matchers.not = {
    toBe: (exp) => check(!Object.is(received, exp), `expected ${fmt(received)} not to be ${fmt(exp)}`),
    toEqual: (exp) => check(!deepEqual(received, exp), `expected values not to be equal`),
    toContain: (sub) => check(!(received != null && received.includes(sub)), `expected ${fmt(received)} not to contain ${fmt(sub)}`),
  };
  return matchers;
}

function fmt(v) {
  try { return typeof v === 'string' ? JSON.stringify(v) : String(v); } catch { return String(v); }
}

export { test, expect };
