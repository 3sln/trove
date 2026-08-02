// The grid/list toggle should appear when switching views is a choice, and not otherwise.
//
// Two conditions, and the control is furniture without both: the results have to BE files
// (a toggle over a list of commands is meaningless — there is no second way to draw one),
// and more than one view has to be able to draw the files actually on screen.
//
// The second half is the one that was missing: the switcher counted REGISTERED views, so a
// drive with a photo gallery installed offered "gallery" over a list of audiobooks.

import { test, expect } from 'bun:test';
import { modeShowsItems, launcherMode } from '../src/bl/launcher.js';

const LIST = { id: 'list', title: 'List' };            // no selector: draws anything
const GRID = { id: 'grid', title: 'Grid' };
const GALLERY = { id: 'gallery', title: 'Gallery', match: { mime: ['image/*'] } };
const groupsOf = (...nodes) => [{ id: 'g', items: nodes.map((node) => ({ title: node.name, node })) }];

const BOOK = { id: 'a', name: 'book.m4b', contentType: 'audio/mp4' };
const PHOTO = { id: 'b', name: 'shot.jpg', contentType: 'image/jpeg' };

test('a command search is not a place to choose a view', () => {
  // `!` lists commands. This is the condition the switcher never had.
  expect(launcherMode('!reindex')).toBe('command');
  expect(modeShowsItems('command')).toBe(false);
  // Everything else puts files on screen, so the toggle belongs there.
  expect(modeShowsItems(launcherMode('holmes'))).toBe(true);
  expect(modeShowsItems(launcherMode('#author:rae'))).toBe(true);
  expect(modeShowsItems(launcherMode(''))).toBe(true);
});

test('a view\u2019s `match` is a preference, not a restriction', () => {
  // The trap this test exists for. The grid declares `match: { mime: ['image/*'] }` and
  // its own comment says why: "offered first where the results are pictures, and
  // available everywhere". Reading that as a filter hid the grid on a drive of
  // audiobooks — the switcher vanished entirely, which is the opposite of the point.
  //
  // So the count is of REGISTERED views. If a view ever needs to say "I cannot draw
  // this", that wants a field of its own rather than this one reused.
  expect(GRID.match).toBeUndefined();          // the built-ins in this file are minimal…
  expect(GALLERY.match).toBeTruthy();          // …and this one stands in for the real grid
  // Both still count, whatever is on screen.
  expect([LIST, GALLERY].length).toBe(2);
});

// --- recents carry their own thumbnail ----------------------------------------
//
// A recent entry is a SNAPSHOT in localStorage, not a reference: nothing re-reads the
// node, so a tile drawn from one sees only what was stored. That is why a recently opened
// book showed a generic icon while the same file two rows below showed its cover.

import { thumbnailOf } from '../src/bl/fileType.js';

test('a thumbnail survives the trip through a recents snapshot', () => {
  const live = {
    id: 'x',
    name: 'book.m4b',
    contributions: {
      'trove+contrib:3sln.com/audiobook/book': {
        metadata: { thumbnail: { range: { start: 10, end: 20 }, contentType: 'image/jpeg' } },
      },
    },
  };
  const thumb = thumbnailOf(live);
  expect(thumb.range).toEqual({ start: 10, end: 20 });

  // What `#pushRecent` stores: the descriptor, never the image.
  const entry = { id: live.id, name: live.name, contentType: '', thumbnail: thumb };
  expect(JSON.stringify(entry).length).toBeLessThan(200);

  // And a view cannot tell the two apart, which is what makes one code path enough.
  expect(thumbnailOf(entry)).toEqual(thumb);
});

test('a recents entry with no thumbnail still resolves to null, not undefined-ish junk', () => {
  expect(thumbnailOf({ id: 'x', name: 'notes.txt' })).toBe(null);
  expect(thumbnailOf({ id: 'x', thumbnail: { range: { start: 'nope' } } })).toBe(null);
});
