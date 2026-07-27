// Which view draws the results.
//
// The rule has three steps and they are ordered deliberately: a saved choice wins, then
// a view whose `match` suits what is actually on screen, then priority. Getting that
// order wrong is not a crash — it is a drive that quietly stops honouring the button
// the user pressed, which is the kind of thing only a test notices.

import { test, expect } from './testkit.js';
import { ContributionRegistry } from '../src/platform/contributions.js';
import {
  activeView, availableViews, chooseView, viewMove, renderView, registerBuiltinViews,
} from '../src/ui/components/views/index.js';

function platform({ when = () => true } = {}) {
  const values = {};
  return {
    contributions: new ContributionRegistry(),
    settings: {
      get: (k) => values[k],
      set: (k, v) => { if (v === undefined) delete values[k]; else values[k] = v; },
    },
    context: { evaluate: when },
  };
}

const img = (name) => ({ node: { id: name, name, contentType: 'image/jpeg' } });
const txt = (name) => ({ node: { id: name, name, contentType: 'text/plain' } });

test('the built-ins register as views, list first', () => {
  const p = platform();
  registerBuiltinViews(p);
  const views = availableViews(p);
  expect(views.map((v) => v.id)).toEqual(['core.view.list', 'core.view.grid']);
  expect(views.every((v) => v.type === 'view')).toBe(true);
  // A view is a render function in the host — that is what makes it drawable at all.
  expect(typeof views[0].render).toBe('function');
});

test('with nothing chosen and nothing pictorial, the list draws', () => {
  const p = platform();
  registerBuiltinViews(p);
  expect(activeView(p, [txt('a.txt'), txt('b.txt'), txt('c.txt')]).id).toBe('core.view.list');
  // And an empty drive is not an excuse to return nothing to draw with.
  expect(activeView(p, []).id).toBe('core.view.list');
});

test('a collection full of photographs opens as a grid without being asked', () => {
  const p = platform();
  registerBuiltinViews(p);
  expect(activeView(p, [img('1.jpg'), img('2.jpg'), img('3.jpg'), img('4.jpg')]).id).toBe('core.view.grid');
  // A couple of pictures among the documents is not a gallery.
  expect(activeView(p, [img('1.jpg'), txt('a.txt'), txt('b.txt'), txt('c.txt')]).id).toBe('core.view.list');
  // Neither is a two-item drive: too small a sample to change the whole layout on.
  expect(activeView(p, [img('1.jpg'), img('2.jpg')]).id).toBe('core.view.list');
});

test('a chosen view wins over what the contents suggest, and can be un-chosen', () => {
  const p = platform();
  registerBuiltinViews(p);
  const photos = [img('1.jpg'), img('2.jpg'), img('3.jpg')];
  chooseView(p, 'core.view.list');
  expect(activeView(p, photos).id).toBe('core.view.list');
  chooseView(p, null);
  // Back to being decided by the contents.
  expect(activeView(p, photos).id).toBe('core.view.grid');
});

// The search transformer read the sentence. "photos from the trip last summer" is a
// request for a gallery as much as it is a query, and nothing downstream can recover
// that — by then all there is to go on is a list of content types.
test('the transformer\'s hint decides the view, under the user\'s own choice', () => {
  const p = platform();
  registerBuiltinViews(p);
  const docs = [txt('a.txt'), txt('b.txt'), txt('c.txt')];

  // Without a hint these are documents and draw as a list.
  expect(activeView(p, docs).id).toBe('core.view.list');
  // With one, the sentence wins over what the content types suggest.
  expect(activeView(p, docs, 'core.view.grid').id).toBe('core.view.grid');

  // But never over a view the user pressed a button for.
  chooseView(p, 'core.view.list');
  expect(activeView(p, docs, 'core.view.grid').id).toBe('core.view.list');
  chooseView(p, null);

  // A hint for a view this build doesn't have is ignored, not an error — a transformer
  // is deployment config and may outlive the build it was written against.
  expect(activeView(p, docs, 'acme.gallery').id).toBe('core.view.list');
  expect(activeView(p, [img('1.jpg'), img('2.jpg'), img('3.jpg')], 'acme.gallery').id).toBe('core.view.grid');
});

test('a saved view that is no longer installed does not leave the drive blank', () => {
  const p = platform();
  registerBuiltinViews(p);
  chooseView(p, 'trove+contrib:acme.com/docs/gallery'); // uninstalled since
  expect(activeView(p, [txt('a.txt')]).id).toBe('core.view.list');
});

test('a when-clause gates a view the same way it gates every other contribution', () => {
  const p = platform({ when: (w) => w === 'yes' });
  registerBuiltinViews(p);
  p.contributions.register('core.view.map', {
    type: 'view', title: 'Map', priority: 90, when: 'no', render: () => null,
  });
  expect(availableViews(p).some((v) => v.title === 'Map')).toBe(false);
  p.contributions.register('core.view.map', {
    type: 'view', title: 'Map', priority: 90, when: 'yes', render: () => null,
  });
  expect(availableViews(p)[0].title).toBe('Map');
});


// A view is the WHOLE results area, so one that cannot draw takes the drive's contents
// off the screen with it. Views are host code with no sandbox around them, which is
// exactly why the guard is here rather than at a frame boundary: a build's own view has
// nothing else to catch it.
const drawCtx = { groups: [{ title: 'All items', items: [] }], index: 0, handlers: {}, state: {}, ui: {} };

test('a view that throws falls back to the list instead of blanking the drive', () => {
  const drawn = renderView({ id: 'core.view.broken', title: 'Broken', render: () => { throw new Error('nope'); } }, drawCtx);
  expect(drawn).toBeTruthy();
  // Not the bare list: it says which view failed, so the drive doesn't just silently
  // stop looking the way it was asked to.
  expect(JSON.stringify(drawn)).toContain('view-error');
  expect(JSON.stringify(drawn)).toContain('Broken');
});

test('a view with nothing to draw with, or no view at all, still draws the list', () => {
  expect(JSON.stringify(renderView(null, drawCtx))).toContain('launch-group');
  expect(JSON.stringify(renderView({ id: 'core.view.empty', title: 'Empty' }, drawCtx))).toContain('launch-group');
});

test('a view may claim an arrow key, but never breaks one', () => {
  const grid = { move: ({ key }) => (key === 'ArrowDown' ? 4 : null) };
  expect(viewMove(grid, 'ArrowDown', {})).toBe(4);
  expect(viewMove(grid, 'ArrowUp', {})).toBe(null);
  // No move function at all: the launcher's own handling stands.
  expect(viewMove({ render: () => null }, 'ArrowDown', {})).toBe(null);
  // A zero delta would swallow the key and move nothing — that is not a claim.
  expect(viewMove({ move: () => 0 }, 'ArrowDown', {})).toBe(null);
  // Neither is nonsense, and a view that throws must not take the arrow keys with it.
  expect(viewMove({ move: () => 'down' }, 'ArrowDown', {})).toBe(null);
  expect(viewMove({ move: () => { throw new Error('nope'); } }, 'ArrowDown', {})).toBe(null);
});
