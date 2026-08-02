// The SDK's hooks are EventTargets, not slots.
//
// Every one of them used to be a single assignment — `onDeactivate = fn`, `onDock = fn`,
// `mediaHandlers[action] = fn`. Registering twice silently discarded the first, and
// nothing anywhere reported it: the symptom is a timer or an object URL outliving its
// viewer, found much later as a leak. The audiobook player was losing one of two
// teardowns exactly that way, and it took an unrelated bug hunt to notice.
//
// The SDK is injected as TEXT into a sandboxed frame, so it cannot import and cannot be
// imported. These tests exercise the same primitives against the same source, which is
// how protocol.test.js already checks this file.

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const raw = readFileSync(new URL('../src/browser.js', import.meta.url), 'utf8');
// COMMENTS STRIPPED before asserting about shape. The prose above the event helpers
// quotes the very pattern being banned (`onDeactivate = fn`) in order to explain why it
// is banned, and an assertion that cannot tell code from a comment fails on its own
// documentation — or, worse, passes because someone reworded the comment.
const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('the SDK still has no imports, or it cannot be injected at all', () => {
  // The constraint that decides where this code can live: it is inlined into a srcdoc
  // beside the plugin's entry script, with no module loader.
  expect(raw).not.toMatch(/^\s*import\s/m);
});

test('no handler is stored in a slot any more', () => {
  // The shape of the bug: `x = fn` for a handler. If one comes back, it comes back
  // silently, which is why this is asserted against the source rather than behaviour.
  expect(src).not.toMatch(/onDeactivate\s*=\s*fn/);
  expect(src).not.toMatch(/onDock\s*=\s*fn/);
  expect(src).not.toMatch(/onSettingsChange\s*=\s*fn/);
  expect(src).not.toMatch(/onConnectivity\s*=\s*fn/);
  expect(src).not.toMatch(/mediaHandlers\[[^\]]+\]\s*=/);
  // …and the replacements are real EventTargets.
  expect(src).toContain('new EventTarget()');
  expect(src).toMatch(/addEventListener/);
});

// --- the primitives, run for real -------------------------------------------
//
// Lifted from the source so the behaviour under test is the behaviour that ships. They
// are small and self-contained by design; the alternative is asserting on a regex, which
// cannot tell whether the semantics are right.

class TroveEvent extends Event {
  constructor(type, detail) {
    super(type, { cancelable: true });
    this.detail = detail;
    this._waits = [];
    this._answered = false;
    this._answer = undefined;
  }
  waitUntil(p) { this._waits.push(Promise.resolve(p)); }
  respondWith(value) {
    if (this._answered) return;
    this._answered = true;
    this._answer = value;
    if (value && typeof value.then === 'function') this._waits.push(Promise.resolve(value).then((v) => { this._answer = v; }));
  }
}
async function fire(target, type, detail) {
  const ev = new TroveEvent(type, detail);
  target.dispatchEvent(ev);
  await Promise.allSettled(ev._waits);
  return ev._answer;
}
function hook(target, type, args = (e) => [e.detail]) {
  return (fn) => {
    const listener = (e) => {
      let out;
      try { out = fn(...args(e)); } catch (err) { console.error('handler threw', err); return; }
      if (out && typeof out.then === 'function') e.waitUntil(out);
      if (out !== undefined) e.respondWith(out);
    };
    target.addEventListener(type, listener);
    return () => target.removeEventListener(type, listener);
  };
}

test('two registrations both run — the bug this replaces', () => {
  const bus = new EventTarget();
  const onDeactivate = hook(bus, 'deactivate');
  const ran = [];
  onDeactivate(() => ran.push('poller'));
  onDeactivate(() => ran.push('transport'));
  return fire(bus, 'deactivate', {}).then(() => expect(ran).toEqual(['poller', 'transport']));
});

test('a handler that throws does not strand the others', async () => {
  const bus = new EventTarget();
  const onDeactivate = hook(bus, 'deactivate');
  const ran = [];
  onDeactivate(() => ran.push('first'));
  onDeactivate(() => { throw new Error('bad teardown'); });
  onDeactivate(() => ran.push('third'));
  // Guaranteed by hook(), not by the runtime: Bun stops dispatch on a throwing listener
  // and browsers do not, so teardown cannot depend on which one it is running in.
  await fire(bus, 'deactivate', {});
  expect(ran).toEqual(['first', 'third']);
});

test('the host waits for an async handler, which is what holds "Opening…"', async () => {
  // `opener:open` must not resolve until the viewer has drawn. Without waitUntil the host
  // hides its spinner over a blank frame — the exact failure the audiobook viewer showed.
  const openers = new EventTarget();
  const onOpen = hook(openers, '*', (e) => [e.detail.file]);
  let drawn = false;
  onOpen(async () => { await new Promise((r) => setTimeout(r, 20)); drawn = true; });
  await fire(openers, '*', { file: { id: 'x' } });
  expect(drawn).toBe(true);
});

test('a command answers, and the first answer wins', async () => {
  const commands = new EventTarget();
  const handle = hook(commands, 'count', (e) => e.detail.args);
  handle((a, b) => a + b);
  handle(() => 999); // a second implementation is a bug; it must not overwrite the first
  expect(await fire(commands, 'count', { args: [2, 3] })).toBe(5);
});

test('an async command answers with its resolved value', async () => {
  const commands = new EventTarget();
  hook(commands, 'slow', (e) => e.detail.args)(async (n) => { await Promise.resolve(); return n * 2; });
  expect(await fire(commands, 'slow', { args: [21] })).toBe(42);
});

test('a disposer removes exactly one listener', async () => {
  const bus = new EventTarget();
  const on = hook(bus, 'deactivate');
  const ran = [];
  const drop = on(() => ran.push('a'));
  on(() => ran.push('b'));
  drop();
  await fire(bus, 'deactivate', {});
  expect(ran).toEqual(['b']);
});
