// Bootstrap: build the platform + ngin app, mount the workbench, and wire the
// cross-cutting behaviours that don't belong to any one component — theme, global
// keybindings, OS drag-and-drop upload, capability probing, and the plugin
// catalog. Mirrors bridle's main.js: assemble providers, reconcile the root
// alias, install shortcuts.

import { dd } from './runtime.js';
import { createPlatform } from './platform/index.js';
import { createApp } from './bl/index.js';
import { NavigateAction, UploadFilesAction } from './bl/actions.js';
import workbenchComposition from './ui/compositions/workbench.js';

const root = document.querySelector('.workbench');

const platform = createPlatform({ baseUrl: '' });
const { engine, app } = createApp(platform);

// --- plugin catalog ---------------------------------------------------------
// A minimal example plugin ships with the app to exercise the sandbox end-to-end.
// Real deployments discover plugins from a registry; each declares its own domain.
const AVAILABLE_PLUGINS = [
  {
    id: 'com.trove.wordcount',
    name: 'Word Count',
    entry: new URL('/plugins/wordcount.html', location.origin).toString(),
    capabilities: ['storage', 'ui', 'commands'],
    description: 'A tiny demo plugin: a persistent click counter in its own database, a command, and a status-bar item — all from inside a sandboxed iframe.',
  },
];

const plugins = {
  available: AVAILABLE_PLUGINS,
  async install(manifest) {
    // In a real UI we'd show a capability-consent dialog here.
    await platform.plugins.load(manifest);
  },
  async uninstall(id) {
    await platform.plugins.unload(id);
  },
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
window.__trove = { platform, engine, app };
