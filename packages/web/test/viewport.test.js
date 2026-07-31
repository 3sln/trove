// Picking a shell for the screen you're actually on.
//
// The consequence of getting this wrong is not cosmetic: a phone that renders the
// desktop rail loses a seventh of its width to chrome and puts every destination out of
// thumb reach, while a desktop that renders the phone shell throws away the status bar
// for no reason. And a TV is the case detection cannot reliably win, which is why the
// override has to outrank it.

import { test, expect } from 'bun:test';
import { ViewportService, looksLikeTv } from '../src/platform/viewport.js';
import { cell, effect } from '../src/runtime.js';
import { ContextRegistry } from '../src/platform/context.js';
import { registerViewportContext } from '../src/bl/context.js';

// A window stand-in: the four things the service actually reads.
function fakeWindow({ width = 1280, height = 800, coarse = false, ua = '', url = 'http://x/' } = {}) {
  return {
    innerWidth: width, innerHeight: height,
    navigator: { userAgent: ua },
    location: { href: url },
    matchMedia: (q) => ({ matches: q.includes('coarse') ? coarse : false }),
    document: { documentElement: { dataset: {} } },
    addEventListener() {}, removeEventListener() {},
  };
}
// `observe()` hands back a cell now, which is what the service watches.
const settingsStub = (layout = 'auto') => ({ get: () => layout, observe: () => cell(layout) });

test('a narrow window is a phone whether or not it is a phone', () => {
  // A desktop window dragged narrow has exactly the phone's problem — no room for a rail
  // beside a panel — so it gets the phone's answer. Keying off touch instead would leave
  // a 380px browser window rendering chrome that doesn't fit.
  const vp = new ViewportService({ window: fakeWindow({ width: 380 }), settings: settingsStub() });
  expect(vp.state.mode).toBe('phone');

  const touchLaptop = new ViewportService({ window: fakeWindow({ width: 1400, coarse: true }), settings: settingsStub() });
  expect(touchLaptop.state.mode).toBe('desktop');
});

test('a television is only believed when the screen is big enough to be one', () => {
  // Set-top browsers announce themselves in the UA. A phone that happens to carry one of
  // those words is still a phone, so the width has to agree.
  expect(looksLikeTv('Mozilla/5.0 (Web0S; Linux/SmartTV)', 1920)).toBe(true);
  expect(looksLikeTv('Mozilla/5.0 (Web0S; Linux/SmartTV)', 400)).toBe(false);
  expect(looksLikeTv('Mozilla/5.0 (Macintosh; Intel Mac OS X)', 1920)).toBe(false);

  const tv = new ViewportService({
    window: fakeWindow({ width: 1920, height: 1080, ua: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0)' }),
    settings: settingsStub(),
  });
  expect(tv.state.mode).toBe('tv');
});

test('what the user chose beats what we guessed', () => {
  // The whole reason this is a setting: a browser on a set-top box usually looks like a
  // large desktop, and someone driving it with a remote must be able to say so.
  const vp = new ViewportService({ window: fakeWindow({ width: 1920 }), settings: settingsStub('tv') });
  expect(vp.state.mode).toBe('tv');
  expect(vp.state.forced).toBe(true);
});

test('?ui= beats even the setting, so a shell can be checked from any machine', () => {
  const vp = new ViewportService({
    window: fakeWindow({ width: 1920, url: 'http://x/?ui=phone' }),
    settings: settingsStub('desktop'),
  });
  expect(vp.state.mode).toBe('phone');
  // Nonsense in the URL falls through to the normal decision rather than breaking the app.
  const junk = new ViewportService({ window: fakeWindow({ width: 1920, url: 'http://x/?ui=fridge' }), settings: settingsStub() });
  expect(junk.state.mode).toBe('desktop');
});

test('resizing across the boundary republishes; jiggling inside it does not', async () => {
  const win = fakeWindow({ width: 1280 });
  const seen = [];
  const vp = new ViewportService({ window: win, settings: settingsStub() });
  effect(vp.observe(), (v) => seen.push(v.mode));
  seen.length = 0; // drop the replayed current value

  win.innerWidth = 1200;
  vp.refresh();
  win.innerWidth = 400;
  vp.refresh();
  win.innerWidth = 390;
  vp.refresh();
  expect(seen).toEqual(['desktop', 'phone', 'phone']); // width changed each time
  expect(vp.state.mode).toBe('phone');

  // No change at all: no event. A re-render per resize event would be one per frame while
  // a window is being dragged.
  const before = seen.length;
  vp.refresh();
  expect(seen.length).toBe(before);
});

test('the mode reaches CSS and when-clauses, not just the components', () => {
  // Two consumers can't each re-derive this: a media query that disagrees with the JS
  // branch above it produces a shell that is half one layout and half the other.
  //
  // The service no longer PUSHES the keys — it holds what it measured and the keys are
  // derived from that (bl/context.js). Same guarantee, and one it cannot forget to honour
  // from a code path that changes the mode without saying so.
  const win = fakeWindow({ width: 400 });
  const vp = new ViewportService({ window: win, settings: settingsStub() });
  vp.install();
  const registry = new ContextRegistry();
  registerViewportContext(registry, vp);

  expect(win.document.documentElement.dataset.layout).toBe('phone');
  expect(registry.get('viewport.mode')).toBe('phone');
  expect(registry.get('viewport.phone')).toBe(true);
  expect(registry.get('viewport.tv')).toBe(false);
  // And it FOLLOWS: a resize the service notices changes the answer without anything
  // being told to write it.
  win.innerWidth = 1400;
  vp.refresh();
  expect(registry.get('viewport.mode')).toBe('desktop');
  expect(registry.get('viewport.phone')).toBe(false);
});

test('unregistering a key takes it out of the snapshot', () => {
  // A contributor registers while it exists. That is what stops the set of keys being a
  // pile that only grows — a plugin's register has to disappear when it is uninstalled, or
  // every when-clause naming it keeps evaluating against a value nobody maintains.
  const registry = new ContextRegistry();
  const off = registerViewportContext(registry, new ViewportService({ window: fakeWindow(), settings: settingsStub() }));
  expect('viewport.mode' in registry.snapshot()).toBe(true);
  off();
  expect('viewport.mode' in registry.snapshot()).toBe(false);
});

test('two owners for one key is refused rather than silently taken over', () => {
  const registry = new ContextRegistry();
  const owned = registry.own('demo.key', 1);
  expect(registry.get('demo.key')).toBe(1);
  expect(() => registry.own('demo.key', 2)).toThrow(/already has an owner/);
  // The writer is the capability: holding the registry is not enough to change anything.
  owned.set(7);
  expect(registry.get('demo.key')).toBe(7);
  owned.dispose();
  expect(registry.has('demo.key')).toBe(false);
});
