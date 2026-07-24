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
import launcher from '../components/launcher.js';
import settingsView from '../components/settingsView.js';
import pluginsView from '../components/pluginsView.js';
import editorArea from '../components/editorArea.js';
import commandPalette from '../components/commandPalette.js';
import { dialog, contextMenu, toasts, transferTray, pluginPanel } from '../components/overlays.js';
import { infoPanel } from '../components/social.js';
import { icon } from '../icon.js';

const { alias, div, button } = dd;

export default function workbench({ engine, app, platform, plugins }) {
  const bump$ = new ObservableSubject(0);
  const ui = {
    engine, app, platform,
    go: (action) => engine.dispatch(action),
    exec: (id, ...args) => platform.commands.execute(id, ...args),
    rerender: () => bump$.next(Date.now()),
    uninstallPlugin: (id) => plugins?.uninstall(id),
    _paletteFiles: [],
  };

  const { watch, zip } = platform.reactive;
  const combined$ = zip(
    (wb, ex, se, tr, notif, ctx, settings, pluginList, statusItems, so, off, _bump) =>
      ({ wb, ex, se, tr, notif, ctx, settings, plugins: pluginList, statusItems, so, off }),
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
    app.offline.observe(),
    bump$,
  );

  return alias(() => watch(combined$, (state) => view(state, ui)));
}

function view(state, ui) {
  return div({ className: `shell ${state.settings['workbench.density'] === 'compact' ? 'compact' : ''}` },
    titleBar(state, ui),
    div({ className: 'body no-sidebar' },
      activityBar(state, ui),
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

function mainArea(state, ui) {
  switch (state.wb.activity) {
    case 'settings': return settingsView(state, ui);
    case 'plugins': return pluginsView(state, ui);
    default:
      // Home: the launcher; when a file is open, the opener is shown beside it
      // (split) or over it (modal) — the user's last choice is the default.
      return state.wb.activeTabId ? workspace(state, ui) : launcher(state, ui);
  }
}

function workspace(state, ui) {
  const modal = state.wb.previewMode === 'modal';
  if (!modal) {
    return div({ className: 'workspace split' },
      div({ className: 'ws-pane ws-launcher' }, launcher(state, ui)),
      div({ className: 'ws-pane ws-preview' }, preview(state, ui)),
    );
  }
  return div({ className: 'workspace modal' },
    launcher(state, ui),
    div({ className: 'preview-scrim' }).on({ click: () => ui.platform.workbench.showHome() }),
    div({ className: 'preview-modal' }, preview(state, ui)),
  );
}

function preview(state, ui) {
  const wb = ui.platform.workbench;
  const modal = state.wb.previewMode === 'modal';
  const inner = state.wb.infoPanel
    ? div({ className: 'editor-split' }, editorArea(state, ui), infoPanel(state, ui))
    : editorArea(state, ui);
  return div({ className: 'preview' },
    div({ className: 'preview-controls' },
      button({ className: 'pc-btn', title: modal ? 'Show beside (split)' : 'Show as modal' }, icon(modal ? 'columns' : 'window', { size: 15 }))
        .on({ click: () => wb.togglePreviewMode() }),
      button({ className: 'pc-btn', title: 'Close (Esc)' }, icon('close', { size: 15 }))
        .on({ click: () => wb.showHome() }),
    ),
    inner,
  );
}

export { NavigateAction };
