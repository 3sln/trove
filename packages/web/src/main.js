// Bootstrap: build the platform + ngin app, mount the workbench, and wire the
// cross-cutting behaviours that don't belong to any one component — theme, global
// keybindings, OS drag-and-drop upload, capability probing, and the plugin
// catalog. Mirrors bridle's main.js: assemble providers, reconcile the root
// alias, install shortcuts.

import { dd } from './runtime.js';
import { createPlatform } from './platform/index.js';
import { createApp } from './bl/index.js';
import { NavigateAction, UploadFilesAction } from './bl/actions.js';
import { parsePackage } from './platform/pluginPackage.js';
import workbenchComposition from './ui/compositions/workbench.js';

const root = document.querySelector('.workbench');

const platform = createPlatform({ baseUrl: '' });
const { engine, app } = createApp(platform);

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
platform.settings.observe().subscribe(() => applyTheme());

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
  engine.dispatch(new UploadFilesAction(e.dataTransfer.files, app.explorer.state.folder?.id));
});

// --- initial load -----------------------------------------------------------
(async () => {
  try {
    platform.capabilities = await platform.api.capabilities();
    platform.workbench.subject.next(platform.workbench.state); // nudge status bar
  } catch (err) {
    platform.notifications.error(`Cannot reach the Trove server: ${err.message}`);
  }
  engine.dispatch(new NavigateAction('/'));
})();

// Expose for debugging / e2e.
window.__trove = {
  platform, engine, app,
  // Test/automation hook: install a package from raw zip bytes.
  test: {
    parsePackage,
    assessTrust: (pkg) => platform.plugins.assessTrust(pkg),
    install: (pkg, opts) => platform.plugins.install(pkg, opts),
  },
};
