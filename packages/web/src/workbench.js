// Booting a workbench — the whole client, as a function you call with what you want
// added to it.
//
// This used to be `main.js`: a fixed sequence that registered a fixed set of openers
// and mounted. Which is fine until someone wants to SHIP a different drive — a hosted
// build with a rich media player, an image-caption indexer and a gallery view — and
// finds the only way in is to fork the package. Every contribution the built-ins use
// goes through the same registry a plugin's does, so there was never a technical reason
// for that; there was only a hard-coded list.
//
//   import { createWorkbench } from '@3sln/trove/web/workbench.js';
//
//   createWorkbench({
//     openers: [{ id: 'acme.player', title: 'Player', priority: 60,
//                 match: { mime: ['video/*'] }, component: player }],
//     views:   [{ id: 'acme.gallery', title: 'Gallery', icon: 'grid', priority: 70,
//                 match: { mime: ['image/*'] }, render: gallery }],
//   });
//
// Two ways to displace a built-in, both falling out of how the registry already works:
// register a HIGHER PRIORITY (selection sorts by it, and the user can still pick the
// plain one from the chooser), or register the SAME ID (the registry is a map, so it is
// replaced outright). Prefer the first — it leaves the original reachable.
//
// These openers and views run IN PROCESS. That is the difference between a build of the
// app and a plugin, and it cuts both ways: full access to the platform, and no sandbox
// to catch a mistake. Anything a user installs is a plugin and stays in its frame.

import { dd, effect } from './runtime.js';
import { createPlatform } from './platform/index.js';
import { createApp } from './bl/index.js';
import { NavigateAction, UploadFilesAction, OpenInitialCollectionAction, OpenSearchModalAction, OpenInPanelAction } from './bl/actions.js';
import { parsePackage } from './platform/pluginPackage.js';
import workbenchComposition from './ui/compositions/workbench.js';
import { registerBuiltinOpeners } from './ui/components/openers/index.js';
import { registerBuiltinViews } from './ui/components/views/index.js';
import { attachMedia } from './ui/media.js';

/**
 * Build the platform, mount the workbench, and wire the cross-cutting behaviours that
 * belong to no single component — theme, global keybindings, OS drag-and-drop upload,
 * capability probing, the plugin catalog.
 *
 * @param {object} [options]
 * @param {Element} [options.root]      where to mount (default `.workbench`)
 * @param {string}  [options.baseUrl]   API origin (default same-origin)
 * @param {Array}   [options.openers]   extra openers: `{ id, title, match, priority?, component }`
 * @param {Array}   [options.views]     extra views: `{ id, title, icon?, match?, priority?, render, move? }`
 * @param {Array}   [options.settings]  extra setting schemas, for whatever those contribute
 * @param {boolean} [options.serviceWorker] register /sw.js (default true)
 * @returns {{platform: object, engine: object, app: object}}
 */
export function createWorkbench({
  root = document.querySelector('.workbench'),
  baseUrl = '',
  openers = [],
  views = [],
  settings = [],
  serviceWorker = true,
} = {}) {
  const platform = createPlatform({ baseUrl });
  const { engine, app } = createApp(platform);

  // Built-in openers and views are UI, so they register from the composition layer
  // (which is allowed to know both platform and ui) rather than from bl/.
  registerBuiltinOpeners(platform);
  registerBuiltinViews(platform);
  // Then whatever this build adds, so a same-id registration replaces the built-in
  // rather than being replaced by it.
  register(platform, 'opener', openers);
  register(platform, 'view', views);
  if (settings.length) platform.settings.register(settings);

  // Plugins are installed by the user (from a .zip or a URL) and persisted locally;
  // restore any that were installed on this device, then run.
  platform.plugins.restore();

  // --- mount ----------------------------------------------------------------
  const App = workbenchComposition({ engine, app, platform });
  dd.reconcile(root, [App()]);

  // --- theme ----------------------------------------------------------------
  const applyTheme = () => {
    document.documentElement.dataset.theme = platform.settings.get('workbench.theme') || 'dark';
  };
  applyTheme();
  effect(platform.settings.observe(), () => applyTheme());

  // --- form factor ----------------------------------------------------------
  // Watch the window so rotating a phone, or dragging a desktop window narrow, re-picks
  // the shell. Also stamps data-layout on <html> for the CSS half of the same decision.
  platform.viewport.install();
  // Ask once whether this browser can transcribe on-device, so the launcher knows
  // whether to offer a microphone. Nothing is downloaded and no permission is requested
  // — see platform/voice.js.
  platform.voice.refresh().catch(() => {});
  // Remote-control navigation, which switches itself on and off with the TV layout.
  platform.spatialNav.install();

  // --- keybindings ----------------------------------------------------------
  platform.keybindings.install(window);

  // --- viewer stack ↔ browser history ---------------------------------------
  // Browser back/forward. The panel stack is the only thing that mirrors itself into
  // history, so this reaches it directly rather than through a shell object.
  window.addEventListener('popstate', (e) => app.navigation.onPopState(e));
  installDoubleShift(engine);

  // --- service worker (offline shell + pinned files + push) -----------------
  if (serviceWorker && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  installDragAndDrop(engine, app);

  // --- initial load ---------------------------------------------------------
  (async () => {
    try {
      // What the server can do is an engine query now — see bl/queries.js. It used to be
      // assigned onto `platform` here and followed by `workbench.touch()`, a poke at an
      // unrelated store purely to make the shell redraw, because writing a plain field
      // invalidates nothing. The query has somewhere for the value to arrive, so the fetch
      // belongs to it and this no longer has to announce it.
    } catch (err) {
      platform.notifications.error(`Cannot reach the Trove server: ${err.message}`);
    }
    // Land on a collection the user can actually read — see OpenInitialCollectionAction.
    engine.dispatch(new OpenInitialCollectionAction());
  })();

  // Expose for debugging / e2e.
  window.__trove = {
    platform, engine, app,
    // Test/automation hook: install a package from raw zip bytes.
    test: {
      parsePackage,
      assessTrust: (pkg) => platform.plugins.assessTrust(pkg),
      install: (pkg, opts) => platform.plugins.install(pkg, opts),
      NavigateAction,
      // Keeping a media element pointed at a URL that still works is the half of signed
      // URLs that only shows up over time, so it is drivable from a probe.
      attachMedia,
    },
  };

  return { platform, engine, app };
}

/**
 * Register a build's own contributions.
 *
 * `id` is required and it is not a formality: an unaddressed contribution cannot be
 * remembered as someone's default opener, cannot be pinned as their view, and cannot be
 * named in a keymap. Failing here is far better than shipping a build whose media
 * player silently forgets which one the user chose.
 */
function register(platform, type, list) {
  for (const c of list) {
    if (!c?.id) throw new Error(`A ${type} passed to createWorkbench needs an "id"`);
    const { id, ...spec } = c;
    platform.contributions.register(id, { type, ...spec });
  }
}

// Double-shift → modal search overlay (Raycast-style). Two Shift presses within 400ms,
// with no other key between, open it.
function installDoubleShift(engine) {
  let lastShift = 0;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' && !e.repeat) {
      const now = Date.now();
      if (now - lastShift < 400) { engine.dispatch(new OpenSearchModalAction()); lastShift = 0; }
      else lastShift = now;
    } else if (e.key !== 'Shift') {
      lastShift = 0;
    }
  });
}

// Dropping files anywhere on the window uploads them to the open collection.
function installDragAndDrop(engine, app) {
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    dragDepth++;
    document.body.classList.add('dragging-file');
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      document.body.classList.remove('dragging-file');
    }
  });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging-file');
    // No collection named: UploadFilesAction resolves the open one itself and refuses
    // visibly when there isn't one. Reading it here only to hand it straight back was the
    // drop target knowing where files go, which is the action's business.
    engine.dispatch(new UploadFilesAction(e.dataTransfer.files));
  });
}
