// "Select this item", and the mode it starts.
//
// There was a `selection` in state and actions that read it, but nothing a person could
// press to build one — so it only ever held whichever row the pointer was over. These are
// the three verbs that make it a selection someone chose.

import { test, expect } from 'bun:test';
import { slice } from '../src/bl/state.js';
import { SelectThisItemAction, ToggleItemSelectedAction, ExitSelectionModeAction } from '../src/bl/actions.js';
import { fileMenuOf } from '../src/bl/launcher.js';

const A = { id: 'a', name: 'a.m4b' };
const B = { id: 'b', name: 'b.m4b' };
const C = { id: 'c', name: 'c.m4b' };
const bag = (init = {}) => ({ explorer: slice({ bulk: false, selection: [], selectionNodes: null, ...init }) });

test('the entry point exists, and is the first thing in the menu', () => {
  // First because it changes what everything below it means: afterwards, actions apply to
  // what is picked rather than to this one file.
  const menu = fileMenuOf(A);
  expect(menu[0].label).toBe('Select this item');
  expect(menu[0].actions[0]).toBeInstanceOf(SelectThisItemAction);
});

test('selecting an item enters the mode with that item picked', async () => {
  const r = bag();
  await new SelectThisItemAction(A).execute(r);
  expect(r.explorer.get().bulk).toBe(true);
  expect(r.explorer.get().selection).toEqual(['a']);
  // The NODE travels, not just the id: the launcher's rows come from search across
  // collections, so an id alone cannot be resolved back to a file.
  expect(r.explorer.get().selectionNodes).toEqual([A]);
});

test('toggling adds and removes, and keeps the order they were picked in', async () => {
  const r = bag();
  await new SelectThisItemAction(A).execute(r);
  await new ToggleItemSelectedAction(B).execute(r);
  await new ToggleItemSelectedAction(C).execute(r);
  expect(r.explorer.get().selection).toEqual(['a', 'b', 'c']);

  await new ToggleItemSelectedAction(B).execute(r);
  expect(r.explorer.get().selection).toEqual(['a', 'c']);
  expect(r.explorer.get().selectionNodes).toEqual([A, C]);
});

test('toggling the last one out leaves the mode on, with nothing picked', async () => {
  // Emptying the selection is not the same as leaving. Dropping out of the mode here would
  // mean an accidental double-click on the only checkbox threw the mode away.
  const r = bag();
  await new SelectThisItemAction(A).execute(r);
  await new ToggleItemSelectedAction(A).execute(r);
  expect(r.explorer.get().bulk).toBe(true);
  expect(r.explorer.get().selection).toEqual([]);
});

test('leaving clears the selection with it', async () => {
  // A mode you have left must not still be acting on things you can no longer see
  // selected — a hidden selection a later command silently operates on is the worse of
  // the two surprises.
  const r = bag();
  await new SelectThisItemAction(A).execute(r);
  await new ToggleItemSelectedAction(B).execute(r);
  await new ExitSelectionModeAction().execute(r);
  expect(r.explorer.get()).toMatchObject({ bulk: false, selection: [], selectionNodes: null });
});

test('a node with no id cannot be selected', async () => {
  const r = bag();
  await new SelectThisItemAction(null).execute(r);
  await new ToggleItemSelectedAction({}).execute(r);
  expect(r.explorer.get().bulk).toBe(false);
  expect(r.explorer.get().selection).toEqual([]);
});

// --- bulk actions act on the whole selection ----------------------------------
//
// `subjectOf` takes the FIRST of a selection, which is right for a verb that can only mean
// one thing — rename, open with — and quietly wrong for one that can mean several. Once a
// person could pick six files, Download and Keep offline would have acted on one of them
// and said nothing about the other five.

import { DownloadSubjectAction, PinAction } from '../src/bl/actions.js';

const three = () => ({
  explorer: slice({ bulk: true, selection: ['a', 'b', 'c'], selectionNodes: [A, B, C] }),
  navigation: { activeTab: () => null },
  notifications: { info() {}, error() {} },
});

test('download runs over every selected file', async () => {
  const asked = [];
  const r = { ...three(), api: { download: async (id, name) => { asked.push(name); return { url: 'blob:x', revoke: false }; } } };
  await new DownloadSubjectAction().execute(r);
  expect(asked).toEqual(['a.m4b', 'b.m4b', 'c.m4b']);
});

test('keep-offline pins every selected file', async () => {
  const pinned = [];
  const r = { ...three(), offline: { pin: async (n) => pinned.push(n.id), unpin: async () => {} } };
  await new PinAction(null, true).execute(r);
  expect(pinned).toEqual(['a', 'b', 'c']);
});

test('an explicit node still wins over the selection', async () => {
  // The context menu passes the file it was opened on. That must beat whatever happens to
  // be selected, or right-clicking one file would act on a different one.
  const pinned = [];
  const r = { ...three(), offline: { pin: async (n) => pinned.push(n.id), unpin: async () => {} } };
  await new PinAction(B, true).execute(r);
  expect(pinned).toEqual(['b']);
});

test('nothing selected and nothing open asks for a file rather than acting', async () => {
  const said = [];
  const r = {
    explorer: slice({ bulk: true, selection: [], selectionNodes: null }),
    navigation: { activeTab: () => null },
    notifications: { info: (m) => said.push(m), error() {} },
    offline: { pin: async () => { throw new Error('should not run'); }, unpin: async () => {} },
  };
  await new PinAction(null, true).execute(r);
  expect(said.length).toBe(1);
});
