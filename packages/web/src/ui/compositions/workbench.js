// Root composition. Assembles the `ui` helper (stable for the app's life),
// zips every reactive slice the shell needs into one snapshot, and renders the
// full workbench from it. Components stay pure — they receive (state, ui) and
// either call ui.exec(commandId) or ui.go(action). This is the only module that
// knows about every service at once.

import { dd, ObservableSubject } from '../../runtime.js';
import { NavigateAction } from '../../bl/actions.js';
import titleBar from '../components/titleBar.js';
import activityBar from '../components/activityBar.js';
import statusBar from '../components/statusBar.js';
import explorer from '../components/explorer.js';
import searchView from '../components/searchView.js';
import settingsView from '../components/settingsView.js';
import pluginsView from '../components/pluginsView.js';
import editorArea from '../components/editorArea.js';
import commandPalette from '../components/commandPalette.js';
import { dialog, contextMenu, toasts, transferTray, pluginPanel } from '../components/overlays.js';
import { infoPanel } from '../components/social.js';

const { alias, div } = dd;

export default function workbench({ engine, app, platform, plugins }) {
  const bump$ = new ObservableSubject(0);
  const ui = {
    engine, app, platform,
    go: (action) => engine.dispatch(action),
    exec: (id, ...args) => platform.commands.execute(id, ...args),
    rerender: () => bump$.next(Date.now()),
    availablePlugins: plugins?.available || [],
    installPlugin: (p) => plugins?.install(p),
    uninstallPlugin: (id) => plugins?.uninstall(id),
    _paletteFiles: [],
  };

  const { watch, zip } = platform.reactive;
  const combined$ = zip(
    (wb, ex, se, tr, notif, ctx, settings, pluginList, statusItems, so, _bump) =>
      ({ wb, ex, se, tr, notif, ctx, settings, plugins: pluginList, statusItems, so }),
    platform.workbench.observe(),
    app.explorer.observe(),
    app.search.observe(),
    app.transfers.observe(),
    platform.notifications.observe(),
    platform.context.observe(),
    platform.settings.observe(),
    platform.plugins.observe() || new ObservableSubject([]),
    platform.contributions.statusItems.observe(),
    app.social.observe(),
    bump$,
  );

  return alias(() => watch(combined$, (state) => view(state, ui)));
}

function view(state, ui) {
  const wb = state.wb;
  const fullActivity = wb.activity === 'plugins' || wb.activity === 'settings';
  const showSidebar = wb.sidebarVisible && !fullActivity;

  return div({ className: `shell ${state.settings['workbench.density'] === 'compact' ? 'compact' : ''}` },
    titleBar(state, ui),
    div({ className: `body ${showSidebar ? '' : 'no-sidebar'}` },
      activityBar(state, ui),
      showSidebar ? sidebar(state, ui) : div(),
      mainArea(state, ui),
    ),
    statusBar(state, ui),
    // Overlays.
    commandPalette(state, ui),
    dialog(state, ui),
    contextMenu(state, ui),
    pluginPanel(state, ui),
    toasts(state, ui),
    transferTray(state, ui),
  );
}

function sidebar(state, ui) {
  switch (state.wb.activity) {
    case 'search': return searchView(state, ui);
    case 'explorer':
    default: return explorer(state, ui);
  }
}

function mainArea(state, ui) {
  switch (state.wb.activity) {
    case 'settings': return settingsView(state, ui);
    case 'plugins': return pluginsView(state, ui);
    default: {
      const showInfo = state.wb.infoPanel;
      if (!showInfo) return editorArea(state, ui);
      return div({ className: 'editor-split' }, editorArea(state, ui), infoPanel(state, ui));
    }
  }
}

export { NavigateAction };
