// Bootstrap: build the platform + ngin app, mount the workbench, and wire the
// cross-cutting behaviours that don't belong to any one component — theme, global
// keybindings, OS drag-and-drop upload, capability probing, and the plugin
// catalog. Mirrors bridle's main.js: assemble providers, reconcile the root
// alias, install shortcuts.

import { dd, effect } from './runtime.js';
import { createPlatform } from './platform/index.js';
import { createApp } from './bl/index.js';
import { NavigateAction, UploadFilesAction, OpenInitialCollectionAction } from './bl/actions.js';
import { parsePackage } from './platform/pluginPackage.js';
import workbenchComposition from './ui/compositions/workbench.js';
import { registerBuiltinOpeners } from './ui/components/openers/index.js';

const root = document.querySelector('.workbench');

const platform = createPlatform({ baseUrl: '' });
const { engine, app } = createApp(platform);
// Built-in openers are UI, so register them from the composition layer (which is
// allowed to know both platform and ui) rather than from bl/ (keeps bl → ui out).
registerBuiltinOpeners(platform);

// Plugins are installed by the user (from a .zip or a URL) and persisted locally;
// restore any that were installed on this device, then run.
platform.plugins.restore();

const plugins = {
  uninstall: (id) => platform.plugins.uninstall(id),
};

// --- mount ------------------------------------------------------------------
const App = workbenchComposition({ engine, app, platform, plugins });
dd.reconcile(root, [App()]);

// --- theme ------------------------------------------------------------------
function applyTheme() {
  document.documentElement.dataset.theme = platform.settings.get('workbench.theme') || 'dark';
}
applyTheme();
effect(platform.settings.observe(), () => applyTheme());

// --- form factor ------------------------------------------------------------
// Watch the window so rotating a phone, or dragging a desktop window narrow, re-picks
// the shell. Also stamps data-layout on <html> for the CSS half of the same decision.
platform.viewport.install();
// Remote-control navigation, which switches itself on and off with the TV layout.
platform.spatialNav.install();

// --- keybindings ------------------------------------------------------------
platform.keybindings.install(window);

// --- viewer stack ↔ browser history -----------------------------------------
window.addEventListener('popstate', (e) => platform.workbench.onPopState(e));

// Double-shift → modal search overlay (Raycast-style). Two Shift presses within
// 400ms, with no other key between, open it.
let lastShift = 0;
window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift' && !e.repeat) {
    const now = Date.now();
    if (now - lastShift < 400) { platform.workbench.openSearchModal(); lastShift = 0; }
    else lastShift = now;
  } else if (e.key !== 'Shift') {
    lastShift = 0;
  }
});

// --- service worker (offline shell + pinned files + push) -------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// --- global drag & drop upload ---------------------------------------------
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
  engine.dispatch(new UploadFilesAction(e.dataTransfer.files, app.explorer.state.collectionId));
});

// --- initial load -----------------------------------------------------------
(async () => {
  try {
    platform.capabilities = await platform.api.capabilities();
    // What the server can do is read straight off `platform`, not held in a store, so
    // nothing invalidated when it arrived. Re-pushing the same state object will not
    // do it either: a cell compares with Object.is and drops a write of what it
    // already holds. Saying "this changed under you" is the store's job.
    platform.workbench.touch(); // the status bar reads capabilities
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
  },
};
