// The host-side contribution registry, and the two things that read a contribution
// URI as data: when-clause keys (registers) and the status-bar HTML sanitizer.

import { test, expect } from './testkit.js';
import { ContributionRegistry, toUri } from '../src/platform/contributions.js';
import { evaluateWhen } from '../src/platform/whenclause.js';

const URI = (n) => `trove+contrib:acme.com/docs/${n}`;

function registry() {
  return new ContributionRegistry();
}

test('a bare name is the host\'s; a plugin contribution is always fully qualified', () => {
  expect(toUri('explorer.delete')).toBe('trove+contrib:core/workbench/explorer.delete');
  expect(toUri(URI('x'))).toBe(URI('x'));

  const r = registry();
  r.register('explorer.delete', { type: 'command', title: 'Delete' });
  // The workbench keeps addressing built-ins by their short name…
  expect(r.get('explorer.delete').title).toBe('Delete');
  // …while the contribution still has a real URI, and no owning plugin.
  expect(r.get('explorer.delete').uri).toBe('trove+contrib:core/workbench/explorer.delete');
  expect(r.get('explorer.delete').pluginId).toBe(null);
  // `id` is what the rest of the app addresses it by: short for core, URI for plugins.
  expect(r.get('explorer.delete').id).toBe('explorer.delete');
});

test('kinds coexist under one plugin without colliding', () => {
  const r = registry();
  const base = { pluginId: 'acme.com/docs' };
  r.register(URI('status'), { ...base, type: 'statusItem', slot: 'right' });
  r.register(URI('busy'), { ...base, type: 'register' });
  r.register(URI('export'), { ...base, type: 'command' });
  // A DIFFERENT plugin's "status" is a different contribution entirely.
  r.register('trove+contrib:acme.com/sheets/status', { pluginId: 'acme.com/sheets', type: 'statusItem', slot: 'left' });

  expect(r.all().length).toBe(4);
  expect(r.ofType('statusItem').length).toBe(2);
  expect(r.get(URI('status')).slot).toBe('right');
  expect(r.get('trove+contrib:acme.com/sheets/status').slot).toBe('left');
  expect(r.ofPlugin('acme.com/docs').length).toBe(3);
  expect(r.ofPlugin('acme.com/docs', 'command').length).toBe(1);
  // `id` and `pluginId` are derived from the address for plugin contributions.
  expect(r.get(URI('busy')).id).toBe(URI('busy'));
  expect(r.get(URI('busy')).name).toBe('busy');
});

test('an unknown type is refused rather than stored as an inert entry', () => {
  const r = registry();
  expect(() => r.register('x', { type: 'gizmo' })).toThrow(/unknown contribution type/i);
  expect(() => r.register('x', {})).toThrow(/unknown contribution type/i);
  expect(r.all().length).toBe(0);
});

test('register/update/unregister drive the reactive views', () => {
  const r = registry();
  const seen = [];
  r.observeType('statusItem').subscribe({ next: (v) => seen.push(v.length) });

  const dispose = r.register(URI('status'), { pluginId: 'acme.com/docs', type: 'statusItem', slot: 'right', html: '' });
  expect(r.ofType('statusItem').length).toBe(1);

  // update() merges — the declared options survive what the plugin pushes.
  expect(r.update(URI('status'), { html: '<b>3</b>', visible: true })).toBe(true);
  expect(r.get(URI('status'))).toMatchObject({ slot: 'right', html: '<b>3</b>', visible: true });
  expect(r.update(URI('nope'), { html: 'x' })).toBe(false); // nothing to drive

  dispose();
  expect(r.ofType('statusItem').length).toBe(0);
  expect(seen[seen.length - 1]).toBe(0);
});

test('unregisterPlugin drops everything one plugin contributed, and nothing else', () => {
  const r = registry();
  r.register('explorer.delete', { type: 'command' });
  r.register(URI('a'), { pluginId: 'acme.com/docs', type: 'command' });
  r.register(URI('b'), { pluginId: 'acme.com/docs', type: 'opener', match: {} });
  r.register('trove+contrib:acme.com/sheets/a', { pluginId: 'acme.com/sheets', type: 'command' });

  r.unregisterPlugin('acme.com/docs');
  expect(r.all().map((c) => c.uri).sort()).toEqual([
    'trove+contrib:acme.com/sheets/a',
    'trove+contrib:core/workbench/explorer.delete',
  ]);
});

test('openers are matched by selector and ordered by priority', () => {
  const r = registry();
  r.register('core.text', { type: 'opener', priority: 10, match: { ext: ['.md'] } });
  r.register(URI('fancy'), { pluginId: 'acme.com/docs', type: 'opener', priority: 50, match: { ext: ['.md'] } });
  r.register('core.image', { type: 'opener', priority: 20, match: { mime: ['image/*'] } });

  const node = { kind: 'file', name: 'a.md', contentType: 'text/markdown' };
  expect(r.openersFor(node).map((o) => o.id)).toEqual([URI('fancy'), 'core.text']);
  expect(r.openerFor(node, () => true).id).toBe(URI('fancy'));
  // `when` and availability both filter, so a gated opener yields to the next best.
  expect(r.openerFor(node, () => true, (o) => !o.pluginId).id).toBe('core.text');
  expect(r.openersFor({ kind: 'file', name: 'a.zip', contentType: 'application/zip' })).toEqual([]);
});

test('keybindings() flattens every keymap, tagged with where it came from', () => {
  const r = registry();
  r.register('keymap.default', { type: 'keymap', bindings: [{ key: 'mod+p', command: 'workbench.quickOpen' }] });
  r.register(URI('keys'), {
    pluginId: 'acme.com/docs', type: 'keymap',
    bindings: [{ key: 'mod+alt+e', command: URI('export') }],
  });
  const all = r.keybindings();
  expect(all.length).toBe(2);
  expect(all.find((b) => b.key === 'mod+alt+e')).toMatchObject({ keymap: URI('keys'), pluginId: 'acme.com/docs' });
  expect(all.find((b) => b.key === 'mod+p').pluginId).toBe(null);
});

test('a when-clause can read a register by its contribution URI', () => {
  const ctx = { 'view.active': 'home', [URI('busy')]: true, [URI('count')]: 3 };
  expect(evaluateWhen(URI('busy'), ctx)).toBe(true);
  expect(evaluateWhen(`!${URI('busy')}`, ctx)).toBe(false);
  expect(evaluateWhen(`${URI('count')} > 2`, ctx)).toBe(true);
  expect(evaluateWhen(`view.active == 'home' && ${URI('busy')}`, ctx)).toBe(true);
  expect(evaluateWhen(`${URI('busy')} && ${URI('count')} < 2`, ctx)).toBe(false);
  // A register nobody set is falsy, not an error.
  expect(evaluateWhen(URI('missing'), ctx)).toBe(false);
  // Core keys still work unchanged.
  expect(evaluateWhen("view.active == 'home'", ctx)).toBe(true);
});
