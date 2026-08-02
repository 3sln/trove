// Two things a walkthrough turned up: what Escape reaches, and what a rename updates.
//
// Both are the same shape of bug — a surface that holds its own COPY of something and does
// not get told when the thing changes, or does not get included when a general "close the
// top thing" runs. Neither is a crash, so neither shows up anywhere but in use.

import { test, expect } from 'bun:test';
import { CloseOverlaysAction } from '../src/bl/actions.js';
import { NavigationService } from '../src/platform/navigation.js';

/** The slice API, enough of it for the Escape ladder. */
const slice = (initial) => {
  let v = initial;
  return { get: () => v, set: (p) => { v = { ...v, ...p }; } };
};

function shell({ overlay = {}, workbench = {}, activityOpen = false, depth = 1 } = {}) {
  const closed = [];
  return {
    closed,
    overlay: slice({
      contextMenu: null, dialog: null, palette: null, pluginPanel: null,
      activityPanel: activityOpen, ...overlay,
    }),
    workbench: slice({ sheet: null, searchModal: false, ...workbench }),
    navigation: {
      get: () => ({ stack: Array.from({ length: depth }, () => ({ kind: 'file' })) }),
      back() { closed.push('back'); },
    },
  };
}

test('Escape closes the activity panel', async () => {
  // It floats over the page and has a close button like every other surface in the ladder,
  // and was the only one Escape did not reach. Its flag is overlay state now, so this rung
  // reads like the other five instead of leasing a task poller to close a panel.
  const r = shell({ activityOpen: true });
  await new CloseOverlaysAction().execute(r);
  expect(r.overlay.get().activityPanel).toBe(false);
});

test('Escape prefers a deliberately-opened panel over the activity panel', async () => {
  // The activity panel opens BY ITSELF when a storage check finishes. If it outranked the
  // plugin panel, finishing a check would make the next Escape close the wrong thing.
  const r = shell({ overlay: { pluginPanel: { id: 'p' } }, activityOpen: true });
  await new CloseOverlaysAction().execute(r);
  expect(r.overlay.get().pluginPanel).toBe(null);
  expect(r.overlay.get().activityPanel).toBe(true);
});

test('Escape still pops the panel stack once nothing is floating', async () => {
  const r = shell({ depth: 2 });
  await new CloseOverlaysAction().execute(r);
  expect(r.closed).toEqual(['back']);
});

test('a rename reaches the recents list, not just the open panel', async () => {
  // Recents hold a snapshot (id, name, contentType), not a reference. Updating only the
  // stack renamed the panel title and left the recent tile on the old name until it aged
  // off the end of the list — which reads as the rename half-working.
  const nav = new NavigationService();
  const node = { id: 'n1', name: 'before.png', contentType: 'image/png', collectionId: 'c1' };
  nav.openFile(node, 'image');
  expect(nav.get().recents[0].name).toBe('before.png');

  nav.updateTabNode({ ...node, name: 'after.png' });
  expect(nav.get().recents[0].name).toBe('after.png');
  expect(nav.get().stack.at(-1).node.name).toBe('after.png');
  // The entry is updated in place rather than duplicated or reordered.
  expect(nav.get().recents.filter((r) => r.id === 'n1')).toHaveLength(1);
});

test('renaming a file that is not in recents leaves them alone', async () => {
  const nav = new NavigationService();
  nav.openFile({ id: 'n1', name: 'kept.png', contentType: 'image/png', collectionId: 'c1' }, 'image');
  const before = nav.get().recents;
  nav.updateTabNode({ id: 'other', name: 'x.png', contentType: 'image/png', collectionId: 'c1' });
  expect(nav.get().recents).toBe(before); // same array — no write, no save
});

test('a deleted file leaves recents, not just the open panel', async () => {
  // It was `closeTab`, so it closed the panel and left the tile — and the tile opened
  // nothing, because the file was in the trash. Worse than a wrong name: a dead end.
  const nav = new NavigationService();
  const gone = { id: 'n1', name: 'gone.png', contentType: 'image/png', collectionId: 'c1' };
  const kept = { id: 'n2', name: 'kept.png', contentType: 'image/png', collectionId: 'c1' };
  nav.openFile(gone, 'image');
  nav.openFile(kept, 'image');
  expect(nav.get().recents.map((r) => r.id)).toEqual(['n2', 'n1']);

  nav.forget('n1');
  expect(nav.get().recents.map((r) => r.id)).toEqual(['n2']);
  // and the panel is gone from the stack with it
  expect(nav.get().stack.some((p) => p.id === 'n1')).toBe(false);
});

test('forgetting the last open file falls back to the launcher', async () => {
  const nav = new NavigationService();
  nav.openFile({ id: 'n1', name: 'only.png', contentType: 'image/png', collectionId: 'c1' }, 'image');
  nav.forget('n1');
  expect(nav.get().stack).toEqual([{ kind: 'search' }]);
  expect(nav.get().activeFile).toBe(null);
});

test('forgetting a file that was never opened changes nothing', async () => {
  const nav = new NavigationService();
  nav.openFile({ id: 'n1', name: 'a.png', contentType: 'image/png', collectionId: 'c1' }, 'image');
  const before = nav.get().recents;
  nav.forget('never-opened');
  expect(nav.get().recents).toBe(before); // same array — no write, no save
});
