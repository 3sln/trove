// The grid/list toggle should appear when switching views is a choice, and not otherwise.
//
// Two conditions, and the control is furniture without both: the results have to BE files
// (a toggle over a list of commands is meaningless — there is no second way to draw one),
// and more than one view has to be able to draw the files actually on screen.
//
// The second half is the one that was missing: the switcher counted REGISTERED views, so a
// drive with a photo gallery installed offered "gallery" over a list of audiobooks.

import { test, expect } from 'bun:test';
import { viewsFor } from '../src/ui/components/views/index.js';
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

test('a view with a selector only counts when it can draw what is on screen', () => {
  // A gallery over a list of audiobooks is not a choice anyone has.
  expect(viewsFor([LIST, GRID, GALLERY], groupsOf(BOOK)).map((v) => v.id)).toEqual(['list', 'grid']);
  // ...and over photographs it is.
  expect(viewsFor([LIST, GRID, GALLERY], groupsOf(PHOTO)).map((v) => v.id)).toEqual(['list', 'grid', 'gallery']);
  // A mixed set keeps it: a view that can draw half the results is still worth offering.
  expect(viewsFor([LIST, GRID, GALLERY], groupsOf(BOOK, PHOTO)).map((v) => v.id))
    .toEqual(['list', 'grid', 'gallery']);
});

test('no results is not the same as nothing matching', () => {
  // While a search is loading there are no nodes to test against. Filtering to zero would
  // make the switcher blink out and back on every keystroke, so "not asked" keeps them.
  expect(viewsFor([LIST, GRID, GALLERY], undefined)).toHaveLength(3);
  expect(viewsFor([LIST, GRID, GALLERY], [])).toHaveLength(3);
  expect(viewsFor([LIST, GRID, GALLERY], [{ id: 'g', items: [] }])).toHaveLength(3);
});

test('items without a node do not drag a selector-carrying view in', () => {
  // Command rows have no `node`. If they counted as "nothing to match against", a
  // command list would show every view — which is the bug, reached the other way.
  const commandRows = [{ id: 'commands', items: [{ title: 'Reindex', badge: 'command' }] }];
  expect(viewsFor([LIST, GRID, GALLERY], commandRows)).toHaveLength(3);
  // Which is exactly why the mode check exists as well, and why one without the other
  // is not enough.
  expect(modeShowsItems('command')).toBe(false);
});
