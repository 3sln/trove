// Does the app actually start?
//
// Nothing else asked. The unit suites exercise queries, actions and pure functions in
// isolation; none of them assembles the real platform, builds the real engine, and renders
// the real shell. So a whole class of failure has been shipping past a green suite and a
// clean build, and being found by a human reloading a browser:
//
//   ReferenceError: RenamePromptAction is not defined   — an import that was never added
//   ReferenceError: r is not defined                    — a rename that missed the parameter
//   ReferenceError: collectionLabel is not defined      — a deleted local with a live call site
//   TypeError: D.capabilities is not a function         — a provider's deps are PROVIDERS,
//                                                          not resources
//
// Four in one refactor. Each broke a visible surface; each was invisible to `bun test` and
// to the bundler, which treats an unknown identifier as a global and says nothing. The
// last one is why a linter alone would not be enough — `no-undef` sees nothing wrong with
// calling a method on something that has one, but of the wrong shape.
//
// This is deliberately shallow. It is not a UI test: it asserts that the thing boots,
// paints, and answers every command without throwing. Depth belongs in the unit suites;
// what was missing was breadth of EXECUTION.
//
// It runs under `npm run test:browser` rather than `bun test`, because the point is to
// exercise the real module graph in a real browser — a DOM stand-in would be testing a
// different renderer than the one that ships.
//
// Checked against the bug it was written for: reintroducing the `collectionLabel` shape
// (a live call site for a local that no longer exists) fails all three tests with
// `ReferenceError: deletedHelper is not defined`, where `bun test` and the bundler both
// stay silent.

import { test, expect } from './testkit.js';
import { createWorkbench } from '../src/workbench.js';
import { dd } from '../src/runtime.js';
import { OpenInPanelAction, ToggleInfoPanelAction } from '../src/bl/actions.js';

/**
 * Let pending work land, then paint.
 *
 * `flush` rather than waiting for an animation frame: dodo schedules renders on rAF, and a
 * headless or backgrounded tab throttles it to nothing — the first version of this file
 * hung on `await requestAnimationFrame` and timed out with the app perfectly healthy. It is
 * also the more honest wait, since it renders everything queued instead of hoping a frame
 * arrives in time.
 */
async function settle(ms = 200) {
  await new Promise((r) => setTimeout(r, ms));
  dd.flush();
  await new Promise((r) => setTimeout(r, 0));
  dd.flush();
}

/**
 * A server that answers everything plausibly and instantly.
 *
 * Real enough for the shell to reach a steady state: a collection to open, items to list,
 * capabilities to consult. Nothing here is the subject of the test — it exists so that the
 * boot path runs to completion rather than stalling on a request nobody answers.
 */
function stubServer() {
  const collection = { id: 'col_test', name: 'Test', storage: { driver: 'memory' } };
  const node = {
    id: 'itm_1', collectionId: 'col_test', name: 'notes.md', size: 12,
    contentType: 'text/markdown', createdAt: Date.now(), updatedAt: Date.now(), tags: {},
  };
  const json = (body) => Promise.resolve(body);
  return {
    routes: {
      '/api/collections': () => json({ collections: [collection], canCreate: true }),
      '/api/capabilities': () => json({
        storage: { presignDownload: false },
        storageDrivers: [{ key: 'memory', label: 'In memory', fields: [] }],
        features: { semanticSearch: true },
        principal: { id: 'anon', anonymous: true },
      }),
      '/api/me': () => json({ principal: { id: 'anon', anonymous: true }, admin: true }),
      '/api/notifications': () => json({ items: [], unread: 0 }),
      '/api/tasks': () => json({ tasks: [], issues: [] }),
      '/api/keys': () => json({ keys: [] }),
    },
    node,
    collection,
  };
}

/** Swap `fetch` for the stub, mount into a detached root, and hand back a teardown. */
async function boot() {
  const server = stubServer();
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    const path = new URL(String(url), location.origin).pathname;
    seen.push(path);
    const route = server.routes[path];
    const body = route
      ? await route()
      // Anything not named above: a shaped-but-empty answer, so the boot path continues
      // rather than stalling. A route this test cared about would be listed.
      : { items: [server.node], collectionId: 'col_test', stats: { items: 1, bytes: 12 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const root = document.createElement('div');
  root.className = 'workbench';
  document.body.appendChild(root);

  // Errors that a render swallows into console.error still count as failures here — dodo
  // catches a throwing builder and renders its error view, so a broken component would
  // otherwise paint "something" and pass.
  const errors = [];
  const realError = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(' ')); realError(...args); };

  const built = createWorkbench({ root, serviceWorker: false });
  await settle(300); // engine leases, query boots, stubbed responses

  // Open the collection, through the command a person would use. A drive with none open
  // shows the gate, and the gate outranks everything else in the main area — so without
  // this the shell is correct and the test would be inspecting the wrong screen.
  await built.platform.commands.execute('collections.switch', 'col_test');
  await settle(200);

  return {
    ...built,
    root,
    errors,
    seen,
    teardown() {
      console.error = realError;
      globalThis.fetch = realFetch;
      root.remove();
    },
  };
}

test('the workbench boots, paints, and reports nothing broken', async () => {
  const app = await boot();
  try {
    // It rendered something structural, not an empty div.
    expect(app.root.querySelector('.shell')).toBeTruthy();
    expect(app.root.querySelector('.statusbar')).toBeTruthy();
    // With a collection open, the launcher is the main area — the gate is gone.
    expect(app.root.querySelector('.launcher')).toBeTruthy();
    // And it asked the server the things a boot asks.
    expect(app.seen).toContain('/api/collections');
    // Nothing threw on the way — including inside a watch, which dodo would otherwise
    // have swallowed into an error view.
    expect(app.errors).toEqual([]);
  } finally {
    app.teardown();
  }
});

test('every registered command resolves to actions and dispatches', async () => {
  const app = await boot();
  try {
    const commands = app.platform.commands;
    const ids = commands.paletteCommands().map((c) => c.id);
    expect(ids.length).toBeGreaterThan(10);

    // The ones that open a native picker are excluded: they would leave an <input> waiting
    // on a dialog no test can answer. Everything else must resolve and run.
    const skip = new Set(['explorer.upload', 'plugins.installFromFile', 'search.voice']);
    const failures = [];
    for (const id of [...commands.handlers.keys()]) {
      if (skip.has(id)) continue;
      try {
        await commands.execute(id);
      } catch (err) {
        failures.push(`${id}: ${err.message}`);
      }
      // Close whatever it opened, so the next one starts from a clean shell.
      await commands.execute('workbench.closeOverlays');
    }
    expect(failures).toEqual([]);
    // A command that failed inside its action surfaces as a console error rather than a
    // throw, so check that too — this is what catches a missing import in an action.
    expect(app.errors).toEqual([]);
  } finally {
    app.teardown();
  }
});

test('opening a file renders its viewer and its details panel', async () => {
  const app = await boot();
  try {
    const node = { id: 'itm_1', collectionId: 'col_test', name: 'notes.md', contentType: 'text/markdown', size: 12 };
    // Through the engine, which is the only way in now that the shell has no facade to
    // poke — and the way the app itself does it.
    await app.engine.dispatch(new OpenInPanelAction(node, 'core.markdown')).next(['complete', 'error']);
    await app.engine.dispatch(new ToggleInfoPanelAction(true)).next(['complete', 'error']);
    await settle(250);

    expect(app.root.querySelector('.viewer-nav')).toBeTruthy();
    // The details panel is where the sidecar query's bootAction fires — rendering it is
    // what proves the query lifecycle runs, since nothing loads it otherwise.
    expect(app.root.querySelector('.infopanel')).toBeTruthy();
    expect(app.errors).toEqual([]);
  } finally {
    app.teardown();
  }
});
