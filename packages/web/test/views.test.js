// Which view draws the results.
//
// The rule has three steps and they are ordered deliberately: a saved choice wins, then
// a view whose `match` suits what is actually on screen, then priority. Getting that
// order wrong is not a crash — it is a drive that quietly stops honouring the button
// the user pressed, which is the kind of thing only a test notices.
//
// The decision is split in two, and the seam is worth stating: WHICH views exist and which
// one was pinned is engine state, and lives in the `views` query (tested through the engine,
// below). Choosing between them also needs the items on screen — which are not something a
// query can be keyed by — so `pickView` is a pure function over the query's output plus
// those items. It used to be one function taking `platform` and reading the contribution
// registry, the context keys and the settings mid-render.

import { test, expect } from './testkit.js';
import { Engine, Provider } from '@3sln/ngin';
import { ContributionRegistry } from '../src/platform/contributions.js';
import { cell } from '../src/runtime.js';
import * as q from '../src/bl/queries.js';
import {
  pickView, viewMove, renderView, registerBuiltinViews,
} from '../src/ui/components/views/index.js';

const settle = () => new Promise((r) => setTimeout(r, 5));

/**
 * The `views` query over a registry, as the app would run it.
 *
 * Read through the engine rather than by calling the projection: the point of moving this
 * out of the render was that the dependency is declared, and a test that reached past the
 * engine would not notice if it stopped being.
 */
async function slice({ when = () => true, saved } = {}) {
  const contributions = new ContributionRegistry();
  registerBuiltinViews({ contributions });
  const values = saved === undefined ? {} : { 'explorer.view': saved };
  const engine = new Engine({
    providers: {
      contributions: Provider.fromSingleton(contributions),
      context: Provider.fromSingleton({ observe: () => cell({}), evaluate: when }),
      settings: Provider.fromSingleton({ observe: () => cell({}), get: (k) => values[k] }),
      plugins: Provider.fromSingleton({}),
      commands: Provider.fromSingleton({}),
      keybindings: Provider.fromSingleton({}),
    },
  });
  let value = null;
  const sub = engine.query(q.views).subscribe((v) => { value = v; });
  await settle();
  sub.unsubscribe?.();
  return { value, contributions, engine };
}

const img = (name) => ({ node: { id: name, name, contentType: 'image/jpeg' } });
const txt = (name) => ({ node: { id: name, name, contentType: 'text/plain' } });

test('the built-ins reach the view as drawable descriptors, list first', async () => {
  const { value } = await slice();
  expect(value.views.map((v) => v.id)).toEqual(['core.view.list', 'core.view.grid']);
  // A view is a render function in the host — that is what makes it drawable at all, and
  // it travels with the query. A renderer is a pure vnode builder, so handing one over is
  // handing over data; the rule a query answers to is about side effects, not callables.
  expect(typeof value.views[0].render).toBe('function');
  expect(value.saved).toBe(null);
});

test('a when-clause gates a view the same way it gates every other contribution', async () => {
  const only = (yes) => ({ when: (w) => w === yes });
  const { value: hidden, contributions, engine } = await slice(only('yes'));
  contributions.register('core.view.map', {
    type: 'view', title: 'Map', priority: 90, when: 'no', render: () => null,
  });
  // Re-read: registering is a change the query is subscribed to.
  let seen = null;
  const sub = engine.query(q.views).subscribe((v) => { seen = v; });
  await settle();
  expect(seen.views.some((v) => v.title === 'Map')).toBe(false);
  expect(hidden.views.some((v) => v.title === 'Map')).toBe(false);

  contributions.register('core.view.map', {
    type: 'view', title: 'Map', priority: 90, when: 'yes', render: () => null,
  });
  await settle();
  expect(seen.views[0].title).toBe('Map');
  sub.unsubscribe?.();
});

test('the pinned view travels with the list, so choosing needs only one read', async () => {
  const { value } = await slice({ saved: 'core.view.grid' });
  expect(value.saved).toBe('core.view.grid');
});

// --- pickView, which is pure -----------------------------------------------------

const VIEWS = [
  { id: 'core.view.list', title: 'List', match: null },
  { id: 'core.view.grid', title: 'Grid', match: { mime: ['image/*', 'video/*'] } },
];
const withSaved = (saved) => ({ views: VIEWS, saved });

test('with nothing chosen and nothing pictorial, the list draws', () => {
  expect(pickView(withSaved(null), [txt('a.txt'), txt('b.txt'), txt('c.txt')]).id).toBe('core.view.list');
  // And an empty drive is not an excuse to return nothing to draw with.
  expect(pickView(withSaved(null), []).id).toBe('core.view.list');
  // Neither is being handed nothing at all — the query is PENDING for a frame or two.
  expect(pickView(undefined, [])).toBe(null);
  expect(pickView({ views: [], saved: null }, [])).toBe(null);
});

test('a collection full of photographs opens as a grid without being asked', () => {
  const p = withSaved(null);
  expect(pickView(p, [img('1.jpg'), img('2.jpg'), img('3.jpg'), img('4.jpg')]).id).toBe('core.view.grid');
  // A couple of pictures among the documents is not a gallery.
  expect(pickView(p, [img('1.jpg'), txt('a.txt'), txt('b.txt'), txt('c.txt')]).id).toBe('core.view.list');
  // Neither is a two-item drive: too small a sample to change the whole layout on.
  expect(pickView(p, [img('1.jpg'), img('2.jpg')]).id).toBe('core.view.list');
});

test('a chosen view wins over what the contents suggest, and can be un-chosen', () => {
  const photos = [img('1.jpg'), img('2.jpg'), img('3.jpg')];
  expect(pickView(withSaved('core.view.list'), photos).id).toBe('core.view.list');
  // Back to being decided by the contents.
  expect(pickView(withSaved(null), photos).id).toBe('core.view.grid');
});

// The search transformer read the sentence. "photos from the trip last summer" is a
// request for a gallery as much as it is a query, and nothing downstream can recover
// that — by then all there is to go on is a list of content types.
test('the transformer\'s hint decides the view, under the user\'s own choice', () => {
  const docs = [txt('a.txt'), txt('b.txt'), txt('c.txt')];

  // Without a hint these are documents and draw as a list.
  expect(pickView(withSaved(null), docs).id).toBe('core.view.list');
  // With one, the sentence wins over what the content types suggest.
  expect(pickView(withSaved(null), docs, 'core.view.grid').id).toBe('core.view.grid');

  // But never over a view the user pressed a button for.
  expect(pickView(withSaved('core.view.list'), docs, 'core.view.grid').id).toBe('core.view.list');

  // A hint for a view this build doesn't have is ignored, not an error — a transformer
  // is deployment config and may outlive the build it was written against.
  expect(pickView(withSaved(null), docs, 'acme.gallery').id).toBe('core.view.list');
  expect(pickView(withSaved(null), [img('1.jpg'), img('2.jpg'), img('3.jpg')], 'acme.gallery').id)
    .toBe('core.view.grid');
});

test('a saved view that is no longer installed does not leave the drive blank', () => {
  expect(pickView(withSaved('trove+contrib:acme.com/docs/gallery'), [txt('a.txt')]).id)
    .toBe('core.view.list');
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
