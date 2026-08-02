// What happens to "Always use this for .m4b files" when that plugin is uninstalled.
//
// The association is a settings entry keyed by opener id, and nothing deletes it on
// uninstall. That turns out to be correct, but it is correct by DESIGN in two places at
// once, and neither is obvious from the other — which is exactly the kind of thing that
// gets "tidied up" into a bug.
//
//   Opening   `OpenFileAction` honours a remembered opener only if it is still AVAILABLE,
//             and `availableOpeners` filters on `plugins.isAvailable`. An uninstalled
//             plugin's contributions are unregistered, so the stale id simply loses and
//             the drive falls back to the chooser or a built-in.
//   Settings  `openerAssociations` marks the row `missing`, so the screen says the opener
//             is gone rather than showing a bare id.
//
// Keeping the row is the better behaviour: reinstalling the plugin restores the id and
// the preference comes back. Deleting it eagerly would silently discard a choice on an
// action — uninstall — that says nothing about file associations.

import { test, expect } from 'bun:test';
import { availableOpeners, rememberedOpenerId, withAssociation, ASSOC_KEY } from '../src/bl/openers.js';

const BOOK = { id: 'itm_1', name: 'book.m4b', contentType: 'audio/mp4' };
const PLUGIN_OPENER = { id: 'trove+contrib:3sln.com/audiobook/player', title: 'Audiobook Player', pluginId: '3sln.com/audiobook', match: { ext: ['.m4b'] } };
const BUILT_IN = { id: 'core.audio', title: 'Audio Player', match: { mime: ['audio/*'] } };

/** A resource bag shaped like the one actions receive. `installed` drives availability. */
const bag = (openers, installed, assoc = {}) => ({
  contributions: { openersFor: () => openers, get: (id) => openers.find((o) => o.id === id) || null },
  context: { evaluate: () => true },
  plugins: { isAvailable: (o) => !o.pluginId || installed.has(o.pluginId), plugins: new Map() },
  settings: { get: (k) => (k === ASSOC_KEY ? assoc : null) },
});

test('a remembered plugin opener is used while the plugin is installed', () => {
  const assoc = withAssociation({}, '.m4b', PLUGIN_OPENER.id);
  const r = bag([PLUGIN_OPENER, BUILT_IN], new Set(['3sln.com/audiobook']), assoc);
  expect(rememberedOpenerId(r, BOOK)).toBe(PLUGIN_OPENER.id);
  expect(availableOpeners(r, BOOK).some((o) => o.id === PLUGIN_OPENER.id)).toBe(true);
});

test('once the plugin is gone the association is ignored, not obeyed', () => {
  // THE POINT. The setting still names it — nothing cleared it — but it is not available,
  // so the open path must not choose it. Obeying a stale id opens nothing.
  const assoc = withAssociation({}, '.m4b', PLUGIN_OPENER.id);
  const r = bag([BUILT_IN], new Set(), assoc);   // uninstalled: its contribution is gone

  expect(rememberedOpenerId(r, BOOK)).toBe(PLUGIN_OPENER.id); // the row survives…
  const avail = availableOpeners(r, BOOK);
  expect(avail.some((o) => o.id === PLUGIN_OPENER.id)).toBe(false); // …and is not offered

  // Which is what `OpenFileAction` tests before honouring it, so the fallback is taken.
  const remembered = rememberedOpenerId(r, BOOK);
  expect(remembered && avail.some((o) => o.id === remembered)).toBe(false);
  expect(avail[0].id).toBe(BUILT_IN.id);
});

test('a plugin still installed but unavailable is treated the same way', () => {
  // `isAvailable` covers more than uninstalled — a viewer that needs the network while
  // offline is skipped too. The remembered id must lose for the same reason.
  const assoc = withAssociation({}, '.m4b', PLUGIN_OPENER.id);
  const r = bag([PLUGIN_OPENER, BUILT_IN], new Set(), assoc);
  expect(availableOpeners(r, BOOK).map((o) => o.id)).toEqual([BUILT_IN.id]);
});

test('reinstalling brings the preference back, which is why the row is kept', () => {
  const assoc = withAssociation({}, '.m4b', PLUGIN_OPENER.id);
  const gone = bag([BUILT_IN], new Set(), assoc);
  expect(availableOpeners(gone, BOOK).some((o) => o.id === PLUGIN_OPENER.id)).toBe(false);

  const back = bag([PLUGIN_OPENER, BUILT_IN], new Set(['3sln.com/audiobook']), assoc);
  const remembered = rememberedOpenerId(back, BOOK);
  expect(availableOpeners(back, BOOK).some((o) => o.id === remembered)).toBe(true);
});

test('a preference can still be dropped on purpose', () => {
  // Keeping stale rows is only defensible if there is a way to clear one, and there is:
  // the settings screen writes a null through the same helper.
  const assoc = withAssociation({}, '.m4b', PLUGIN_OPENER.id);
  expect(withAssociation(assoc, '.m4b', null)['.m4b']).toBeUndefined();
});
