// Arriving at a share link.
//
// A link names its collection, so being asked which collection to open would be absurd —
// this has to run ahead of both the remembered choice and the chooser gate. And every way
// it can fail has to say which way, because "collection you cannot read" and "item was
// renamed" used to be indistinguishable from an empty drive.

import { test, expect } from './testkit.js';
import { OpenInitialCollectionAction } from '../src/bl/actions.js';
import { shareUrl, parseShareUrl } from '@3sln/trove/core/links.js';

/**
 * The resources this action leases, and a record of what it did.
 *
 * Flat, because the engine's resources are flat — this used to be an `app` double with a
 * `platform` inside it, which mirrored a single god-provider that no longer exists.
 */
function appFor({ collections = [], node = null, statThrows = false } = {}) {
  const state = { set: [], dispatched: [], notes: [] };
  const app = {
    explorer: {
      state: {},
      set(patch) { state.set.push(patch); Object.assign(this.state, patch); },
    },
    // A feed, not a promise — that is what `dispatch` answers, and the double said
    // otherwise for as long as nothing here waited for an action to actually finish.
    engine: {
      dispatch(a) {
        state.dispatched.push(a.constructor.name);
        return { next: async () => ({ type: 'complete' }) };
      },
    },
    settings: { get: () => null },
    notifications: {
      warn: (m) => state.notes.push(['warn', m]),
      error: (m) => state.notes.push(['error', m]),
      success: (m) => state.notes.push(['success', m]),
    },
    api: {
      collections: async () => ({ collections, canCreate: true }),
      // The real API answers `{ node }`, not the node. Mocking the shape I assumed
      // rather than the one it returns is exactly how the first version of this shipped
      // a resolver that always reported the item as missing.
      stat: async () => { if (statThrows) throw new Error('nope'); return node ? { node } : {}; },
    },
  };
  return { app, state };
}

/**
 * Point the "address bar" at a path.
 *
 * Under bun there is no location or history, so this installs the smallest pair that the
 * action uses — it reads `location.pathname` and calls `history.replaceState`. In a real
 * browser the natives are already there and are used unchanged.
 */
const hasDom = typeof globalThis.location !== 'undefined' && typeof globalThis.history !== 'undefined';
if (!hasDom) {
  let path = '/';
  globalThis.location = { get pathname() { return path; } };
  globalThis.history = { replaceState(_s, _t, next) { path = next; } };
}
const at = (path) => globalThis.history.replaceState(null, '', path);

test('a share link opens its collection and item, ahead of the remembered one', async () => {
  at('/c/photos/i/sunset.jpg');
  const { app, state } = appFor({
    collections: [{ id: 'photos', name: 'Photos' }, { id: 'docs', name: 'Docs' }],
    node: { id: 'itm_1', name: 'sunset.jpg', collectionId: 'photos' },
  });
  await new OpenInitialCollectionAction().execute(app);

  // Never gated: the link already answered the question the gate asks.
  expect(app.explorer.state.gate).toBe(null);
  expect(state.dispatched).toContain('NavigateAction');
  expect(state.dispatched).toContain('OpenFileAction');
});

test('the URL is consumed, so it cannot go stale as the user navigates on', async () => {
  // The app does not otherwise reflect its state in the address bar, and a URL that lies
  // is worse than one that is merely uninformative.
  at('/c/photos/i/sunset.jpg');
  const { app } = appFor({
    collections: [{ id: 'photos' }],
    node: { id: 'itm_1', name: 'sunset.jpg' },
  });
  await new OpenInitialCollectionAction().execute(app);
  expect(location.pathname).toBe('/');
});

test('a link to a collection you cannot read says so, rather than showing an empty drive', async () => {
  at('/c/secret/i/a.txt');
  const { app } = appFor({ collections: [{ id: 'photos' }] });
  await new OpenInitialCollectionAction().execute(app);
  expect(app.explorer.state.error).toMatch(/do not have access to/);
  expect(app.explorer.state.error).toMatch(/secret/);
  // Not the chooser: this is a different problem from "which collection did you want".
  expect(app.explorer.state.gate).toBe(null);
});

test('a link whose item has been renamed lands in the collection and says what is missing', async () => {
  // A link by name breaks on rename, deliberately and visibly.
  at('/c/photos/i/old-name.jpg');
  const { app, state } = appFor({ collections: [{ id: 'photos' }], node: null });
  await new OpenInitialCollectionAction().execute(app);
  expect(state.dispatched).toContain('NavigateAction');
  expect(state.dispatched).not.toContain('OpenFileAction');
  const warned = state.notes.find(([kind]) => kind === 'warn');
  expect(warned[1]).toMatch(/renamed or removed/);
  expect(warned[1]).toMatch(/old-name\.jpg/);
});

test('a link by id says something different when the item is gone', async () => {
  at('/c/photos/i/id:itm_gone');
  const { app, state } = appFor({ collections: [{ id: 'photos' }], statThrows: true });
  await new OpenInitialCollectionAction().execute(app);
  expect(state.notes.find(([k]) => k === 'warn')[1]).toMatch(/no longer exists/);
});

test('an ordinary URL still gets the usual boot', async () => {
  at('/');
  const { app } = appFor({ collections: [{ id: 'photos' }, { id: 'docs' }] });
  await new OpenInitialCollectionAction().execute(app);
  // Two collections and nothing remembered — the chooser, exactly as before.
  expect(app.explorer.state.gate).toBe('choose');
});

test('the link a user copies is the one the app can read back', async () => {
  // The two halves are written from the same module; this is the round trip that proves
  // the produced URL is the consumed one.
  const node = { id: 'itm_1', name: 'sunset.jpg', collectionId: 'photos' };
  const url = shareUrl(node, 'https://drive.example.com');
  expect(parseShareUrl(url)).toEqual({ collection: 'photos', by: 'name', value: 'sunset.jpg' });
});
