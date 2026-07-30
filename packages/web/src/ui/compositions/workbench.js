// Root composition. Assembles the `ui` helper (stable for the app's life),
// zips every reactive slice the shell needs into one snapshot, and renders the
// full workbench from it. Components stay pure — they receive (state, ui) and
// either call ui.exec(commandId) or ui.go(action). This is the only module that
// knows about every service at once.

import { dd, cell, derive, constant } from '../../runtime.js';
import { NavigateAction } from '../../bl/actions.js';
import activityBar from '../components/activityBar.js';
import statusBar from '../components/statusBar.js';
import launcher from '../components/launcher.js';
import settingsView from '../components/settingsView.js';
import collectionGate from '../components/collectionGate.js';
import pluginsView from '../components/pluginsView.js';
import editorArea from '../components/editorArea.js';
import commandPalette from '../components/commandPalette.js';
import { dialog, contextMenu, toasts, transferTray, pluginPanel } from '../components/overlays.js';
import activityPanel from '../components/activityPanel.js';
import { infoPanel } from '../components/social.js';
import { phoneTopBar, phoneBottomBar, phoneSheet } from '../components/phoneChrome.js';

const { alias, div } = dd;

export default function workbench({ engine, app, platform, plugins }) {
  // A counter rather than a timestamp: a cell drops a write of the value it already
  // holds, and two `rerender()` calls in the same millisecond would have compared equal.
  const bump = cell(0);
  const ui = {
    engine, app, platform,
    go: (action) => engine.dispatch(action),
    exec: (id, ...args) => platform.commands.execute(id, ...args),
    rerender: () => bump.update((n) => n + 1),
    uninstallPlugin: (id) => plugins?.uninstall(id),
  };

  const { watch } = platform.reactive;
  // One derived snapshot of every slice the shell reads. `derive` invalidates when any
  // of them does and recomputes once on the next read, so fifteen changes in a frame
  // still cost one render.
  const combined = derive(
    [
      platform.workbench.observe(),
      platform.workbench.observeOverlay(),
      platform.workbench.observeNav(),
      app.explorer.observe(),
      app.search.observe(),
      app.apiKeys.observe(),
      app.transfers.observe(),
      platform.notifications.observe(),
      platform.context.observe(),
      platform.settings.observe(),
      platform.plugins.observe() ?? constant([]),
      platform.contributions.observeType('statusItem'),
      app.social.observe(),
      app.offline.observe(),
      app.activity.observe(),
      platform.viewport.observe(),
      platform.voice.observe(),
      bump,
    ],
    // `_bump` is IN the snapshot, unlike before. `watch` skips a render whose value is
    // shallow-equal to the last one, so a forced re-render that left no trace in the
    // object would be discarded as "nothing changed" — which is the opposite of what
    // asking for one means.
    (wb, overlay, nav, ex, se, keys, tr, notif, ctx, settings, pluginList, statusItems, so, off, act, vp, voice, _bump) =>
      ({ wb, overlay, nav, ex, se, keys, tr, notif, ctx, settings, plugins: pluginList, statusItems, so, off, act, vp, voice, _bump }),
  );

  return alias(() => watch(combined, (state) => view(state, ui)));
}

function view(state, ui) {
  const mode = state.vp?.mode || 'desktop';
  const phone = mode === 'phone';
  return div({ className: `shell ${mode} ${state.settings['workbench.density'] === 'compact' ? 'compact' : ''}` },
    // On a phone the rail becomes a bottom bar and the status bar folds behind one icon
    // in a top bar — see phoneChrome. Everything between them is identical, which is the
    // point: only the chrome changes shape, not the app.
    phone ? phoneTopBar(state, ui) : null,
    div({ className: 'body' },
      phone ? null : activityBar(state, ui),
      mainArea(state, ui),
    ),
    phone ? phoneBottomBar(state, ui) : statusBar(state, ui),
    phone ? phoneSheet(state, ui) : null,
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
  // Before a collection is known there is nothing to draw: every scoped request names one
  // in its path, so a file list, a search box and an Upload button would all be lying.
  // Settings stays reachable — an admin with no collections still needs to get at it.
  if (state.ex?.gate && state.wb.activity !== 'settings') return collectionGate(state, ui);

  switch (state.wb.activity) {
    case 'settings': return settingsView(state, ui);
    case 'plugins': return pluginsView(state, ui);
    default: {
      // Home: the top of the panel stack — the launcher (base search) or, once a
      // file is open, its opener full-width (optionally split with the info panel).
      if (!state.nav.activeTabId) return launcher(state, ui);
      if (!state.wb.infoPanel) return editorArea(state, ui);
      // A 340px rail beside a 390px screen leaves nothing on either side. On a phone the
      // details panel takes the whole panel instead — it has its own close button, so
      // there is still a way back to the file.
      return state.vp?.mode === 'phone'
        ? infoPanel(state, ui)
        : div({ className: 'editor-split' }, editorArea(state, ui), infoPanel(state, ui));
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
