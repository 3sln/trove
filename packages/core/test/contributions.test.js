// Plugin identity and the manifest's contribution map — the two things every other
// part of the plugin system is addressed through.

import { test, expect } from 'bun:test';
import {
  pluginId, contribUri, coreUri, parseContribUri, ownsUri, assertIdentity,
  isValidDomain, isValidName,
} from '../src/plugins/identity.js';
import {
  declaredContributions, contributionsOfType, serverIndexers, parseKeymap, CONTRIBUTION_TYPES,
} from '../src/plugins/contributions.js';

const M = {
  domain: 'acme.com', name: 'docs', entry: 'src/index.js',
  contributes: {
    pdfViewer: { type: 'opener', title: 'PDF', match: { ext: ['.pdf'] }, entry: 'src/openers/pdf.js' },
    pdfIndex: { type: 'indexer', match: { ext: ['.pdf'] }, entry: 'src/indexers/pdf.js' },
    status: { type: 'statusItem', slot: 'left', order: 3 },
    busy: { type: 'register', default: false },
    export: { type: 'command', title: 'Export' },
    keys: { type: 'keymap', path: 'keymaps/default.json' },
  },
};

test('a plugin is identified by domain + name, and the core domain is reserved', () => {
  expect(pluginId(M)).toBe('acme.com/docs');
  expect(isValidDomain('acme.com')).toBe(true);
  expect(isValidDomain('sub.acme.co.uk')).toBe(true);
  expect(isValidDomain('mystuff')).toBe(false);   // a bare label proves nothing
  expect(isValidDomain('')).toBe(false);
  expect(isValidName('docs-2')).toBe(true);
  expect(isValidName('has/slash')).toBe(false);

  expect(() => assertIdentity({ name: 'x' })).toThrow(/domain/i);
  expect(() => assertIdentity({ domain: 'acme.com' })).toThrow(/name/i);
  expect(() => assertIdentity({ domain: 'core', name: 'x' })).toThrow(/reserved/i);
});

test('every contribution has a URI scoped under its plugin', () => {
  expect(contribUri(M, 'pdfViewer')).toBe('trove+contrib:acme.com/docs/pdfViewer');
  expect(coreUri('explorer.delete')).toBe('trove+contrib:core/workbench/explorer.delete');

  const p = parseContribUri('trove+contrib:acme.com/docs/pdfViewer');
  expect(p).toEqual({ domain: 'acme.com', plugin: 'docs', name: 'pdfViewer', pluginId: 'acme.com/docs' });
  expect(parseContribUri('explorer.delete')).toBe(null);
  expect(parseContribUri('trove+contrib:acme.com/docs')).toBe(null); // no contribution name

  // Ownership is a property of the address, so nobody can mint one under your name.
  expect(ownsUri(M, 'trove+contrib:acme.com/docs/anything')).toBe(true);
  expect(ownsUri(M, 'trove+contrib:acme.com/sheets/anything')).toBe(false);
  expect(ownsUri(M, 'trove+contrib:evil.com/docs/anything')).toBe(false);
});

test('kinds share one namespace per plugin, so a name means exactly one thing', () => {
  // The same name under two plugins is two different contributions…
  const other = { ...M, name: 'sheets' };
  expect(contribUri(M, 'status')).not.toBe(contribUri(other, 'status'));
  // …and within one plugin a name can only be claimed once, whatever its type.
  const clash = { ...M, contributes: { status: { type: 'register' } } };
  const uris = declaredContributions(clash).map((c) => c.uri);
  expect(uris).toEqual([contribUri(M, 'status')]);
});

test('declaredContributions normalizes each type and defaults `entry` to the manifest\'s', () => {
  const by = Object.fromEntries(declaredContributions(M).map((c) => [c.name, c]));
  expect(Object.keys(by).sort()).toEqual(['busy', 'export', 'keys', 'pdfIndex', 'pdfViewer', 'status']);

  expect(by.pdfViewer).toMatchObject({ type: 'opener', priority: 50, offline: false, entry: 'src/openers/pdf.js' });
  expect(by.status).toMatchObject({ type: 'statusItem', slot: 'left', render: 'html', order: 3 });
  expect(by.busy).toMatchObject({ type: 'register', default: false });
  expect(by.export).toMatchObject({ type: 'command', title: 'Export', palette: true });
  expect(by.keys).toMatchObject({ type: 'keymap', path: 'keymaps/default.json' });
  expect(by.pdfViewer.pluginId).toBe('acme.com/docs');

  // An opener that names no entry falls back to the plugin's main entry module.
  const noEntry = { ...M, contributes: { v: { type: 'opener', match: {} } } };
  expect(contributionsOfType(noEntry, 'opener')[0].entry).toBe('src/index.js');
});

test('a malformed declaration fails loudly — the review must match what registers', () => {
  const bad = (contributes, extra) => () => declaredContributions({ ...M, contributes, ...extra });
  expect(bad({ x: { type: 'gizmo' } })).toThrow(/unknown type/i);
  expect(bad({ x: {} })).toThrow(/unknown type/i);
  expect(bad({ x: 'nope' })).toThrow(/must be an object/i);
  expect(bad({ 'bad name': { type: 'command' } })).toThrow(/invalid contribution name/i);
  expect(bad({ x: { type: 'keymap' } })).toThrow(/path/i);
  expect(bad({ x: { type: 'statusItem', render: 'svg' } })).toThrow(/html/i);
  expect(bad({ x: { type: 'opener', match: {} } }, { entry: undefined })).toThrow(/entry/i);
  // The old per-kind array form is not silently ignored.
  expect(bad([{ id: 'x', type: 'command' }])).toThrow(/map of name/i);
  // No contributions at all is fine.
  expect(declaredContributions({ ...M, contributes: undefined })).toEqual([]);
});

test('indexers are server-side and namespaced by their contribution URI', () => {
  const idx = serverIndexers(M);
  expect(idx).toEqual([{
    id: 'trove+contrib:acme.com/docs/pdfIndex', name: 'pdfIndex', title: 'pdfIndex',
    match: { ext: ['.pdf'] }, entry: 'src/indexers/pdf.js',
  }]);
});

test('parseKeymap reads a VS Code-shaped keymap and drops unusable entries', () => {
  const km = parseKeymap(JSON.stringify([
    { key: 'mod+k', command: 'export' },
    { key: 'mod+j', command: 'export', when: 'trove+contrib:acme.com/docs/busy', args: [1] },
    { key: 'mod+l' },              // no command
    { command: 'export' },         // no key
    null,
  ]));
  expect(km).toEqual([
    { key: 'mod+k', command: 'export', when: null, args: undefined },
    { key: 'mod+j', command: 'export', when: 'trove+contrib:acme.com/docs/busy', args: [1] },
  ]);
  // The `{ bindings: [...] }` wrapper is accepted too.
  expect(parseKeymap('{"bindings":[{"key":"a","command":"b"}]}').length).toBe(1);
  expect(() => parseKeymap('not json')).toThrow(/valid JSON/i);
  expect(() => parseKeymap('{"nope":1}')).toThrow(/array of bindings/i);
});

test('the type list is the single source of truth for what may be declared', () => {
  expect(CONTRIBUTION_TYPES.sort()).toEqual(['command', 'indexer', 'keymap', 'opener', 'register', 'statusItem']);
});
