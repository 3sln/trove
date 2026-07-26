// Root composition. Assembles the `ui` helper (stable for the app's life),
// zips every reactive slice the shell needs into one snapshot, and renders the
// full workbench from it. Components stay pure — they receive (state, ui) and
// either call ui.exec(commandId) or ui.go(action). This is the only module that
// knows about every service at once.

import { dd, ObservableSubject } from '../../runtime.js';
import { NavigateAction } from '../../bl/actions.js';
import activityBar from '../components/activityBar.js';
import statusBar from '../components/statusBar.js';
import launcher from '../components/launcher.js';
import settingsView from '../components/settingsView.js';
import pluginsView from '../components/pluginsView.js';
import editorArea from '../components/editorArea.js';
import commandPalette from '../components/commandPalette.js';
import { dialog, contextMenu, toasts, transferTray, pluginPanel } from '../components/overlays.js';
import activityPanel from '../components/activityPanel.js';
import { infoPanel } from '../components/social.js';

const { alias, div } = dd;

export default function workbench({ engine, app, platform, plugins }) {
  const bump$ = new ObservableSubject(0);
  const ui = {
    engine, app, platform,
    go: (action) => engine.dispatch(action),
    exec: (id, ...args) => platform.commands.execute(id, ...args),
    rerender: () => bump$.next(Date.now()),
    uninstallPlugin: (id) => plugins?.uninstall(id),
  };

  const { watch, zip } = platform.reactive;
  const combined$ = zip(
    (wb, overlay, nav, ex, se, tr, notif, ctx, settings, pluginList, statusItems, so, off, act, _bump) =>
      ({ wb, overlay, nav, ex, se, tr, notif, ctx, settings, plugins: pluginList, statusItems, so, off, act }),
    platform.workbench.observe(),
    platform.workbench.observeOverlay(),
    platform.workbench.observeNav(),
    app.explorer.observe(),
    app.search.observe(),
    app.transfers.observe(),
    platform.notifications.observe(),
    platform.context.observe(),
    platform.settings.observe(),
    platform.plugins.observe() || new ObservableSubject([]),
    platform.contributions.observeType('statusItem'),
    app.social.observe(),
    app.offline.observe(),
    app.activity.observe(),
    bump$,
  );

  return alias(() => watch(combined$, (state) => view(state, ui)));
}

function view(state, ui) {
  return div({ className: `shell ${state.settings['workbench.density'] === 'compact' ? 'compact' : ''}` },
    div({ className: 'body' },
      activityBar(state, ui),
      mainArea(state, ui),
    ),
    statusBar(state, ui),
    // Overlays.
    searchModal(state, ui),
    commandPalette(state, ui),
    dialog(state, ui),
    contextMenu(state, ui),
    pluginPanel(state, ui),
    toasts(state, ui),
    transferTray(state, ui),
    activityPanel(state, ui),
  );
}

function mainArea(state, ui) {
  switch (state.wb.activity) {
    case 'settings': return settingsView(state, ui);
    case 'plugins': return pluginsView(state, ui);
    default: {
      // Home: the top of the panel stack — the launcher (base search) or, once a
      // file is open, its opener full-width (optionally split with the info panel).
      if (!state.nav.activeTabId) return launcher(state, ui);
      return state.wb.infoPanel
        ? div({ className: 'editor-split' }, editorArea(state, ui), infoPanel(state, ui))
        : editorArea(state, ui);
    }
  }
}

// Double-shift search: the launcher as a modal overlay. Picking an item resets the
// viewer stack (starts over) — the launcher reads state.wb.searchModal to know.
function searchModal(state, ui) {
  if (!state.wb.searchModal) return div();
  return div({ className: 'search-modal' },
    div({ className: 'scrim' }).on({ click: () => ui.platform.workbench.closeSearchModal() }),
    div({ className: 'search-modal-panel' }, launcher(state, ui, { modal: true })),
  );
}

export { NavigateAction };
