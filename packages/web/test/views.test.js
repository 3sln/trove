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

function platform({ available = () => true, when = () => true } = {}) {
  const values = {};
  return {
    contributions: new ContributionRegistry(),
    settings: {
      get: (k) => values[k],
      set: (k, v) => { if (v === undefined) delete values[k]; else values[k] = v; },
    },
    context: { evaluate: when },
    plugins: { isAvailable: available },
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

test('a saved view that is no longer installed does not leave the drive blank', () => {
  const p = platform();
  registerBuiltinViews(p);
  chooseView(p, 'trove+contrib:acme.com/docs/gallery'); // uninstalled since
  expect(activeView(p, [txt('a.txt')]).id).toBe('core.view.list');
});

test('an unavailable view is not offered — offline, or a plugin that is not answering', () => {
  const p = platform({ available: (v) => v.id !== 'core.view.grid' });
  registerBuiltinViews(p);
  expect(availableViews(p).map((v) => v.id)).toEqual(['core.view.list']);
  // Including when it is the saved one: it cannot draw, so something else must.
  chooseView(p, 'core.view.grid');
  expect(activeView(p, [img('1.jpg'), img('2.jpg'), img('3.jpg')]).id).toBe('core.view.list');
});

test('a when-clause gates a view the same way it gates every other contribution', () => {
  const p = platform({ when: (w) => w === 'yes' });
  registerBuiltinViews(p);
  p.contributions.register('trove+contrib:acme.com/docs/map', {
    pluginId: 'acme.com/docs', type: 'view', title: 'Map', priority: 90, when: 'no', render: () => null,
  });
  expect(availableViews(p).some((v) => v.title === 'Map')).toBe(false);
});

// A view is the WHOLE results area, so one that cannot draw takes the drive's contents
// off the screen with it. Both cases below fall back to the list rather than to nothing:
// an in-process view that threw (a build's own code, with no sandbox around it), and a
// plugin's view, which is a real registration this build has no frame protocol for yet.
const drawCtx = { groups: [{ title: 'All items', items: [] }], index: 0, handlers: {}, state: {}, ui: {} };

test('a view that throws falls back to the list instead of blanking the drive', () => {
  const drawn = renderView({ id: 'core.view.broken', title: 'Broken', render: () => { throw new Error('nope'); } }, drawCtx);
  expect(drawn).toBeTruthy();
  // Not the bare list: it says which view failed, so the drive doesn't just silently
  // stop looking the way it was asked to.
  expect(JSON.stringify(drawn)).toContain('view-error');
  expect(JSON.stringify(drawn)).toContain('Broken');
});

test('a plugin view this build cannot draw says so, and draws the list underneath', () => {
  const drawn = renderView({ id: 'trove+contrib:acme.com/docs/gallery', pluginId: 'acme.com/docs', title: 'Gallery' }, drawCtx);
  expect(JSON.stringify(drawn)).toContain('Gallery');
  expect(JSON.stringify(drawn)).toContain('launch-group');
});

test('no view at all still draws the list', () => {
  expect(renderView(null, drawCtx)).toBeTruthy();
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
