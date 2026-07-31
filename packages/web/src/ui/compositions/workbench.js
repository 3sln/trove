// Root composition. Assembles the `ui` helper (stable for the app's life),
// zips every reactive slice the shell needs into one snapshot, and renders the
// full workbench from it. Components stay pure — they receive (state, ui) and
// either call ui.engine.dispatch(new ExecCommandAction(commandId)) or ui.engine.dispatch(action). This is the only module that
// knows about every service at once.

import { dd, derive, constant, watch } from '../../runtime.js';
import { region } from '../region.js';
import { watchQuery } from '../../bl/watchQuery.js';
import * as q from '../../bl/queries.js';
import { CloseSearchModalAction, ExecCommandAction, NavigateAction } from '../../bl/actions.js';
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

export default function workbench({ engine, app, platform }) {
  // What a component is handed, and it is nearly nothing now.
  //
  // `engine` is the thing components talk to: `dispatch` for an action, `query` for a
  // question. It was removed once for being unreferenced, which was true and backwards —
  // nothing referenced it precisely BECAUSE `go` and `exec` stood in for it, and `exec`
  // called the command service directly, so every menu item, keybinding and palette entry
  // a person triggered was invisible to the engine.
  //
  // Both are gone. `go(action)` was `engine.dispatch(action)` with a shorter name, and a
  // shorter name for the one door is how the door stops being obvious. Call sites say
  // `ui.engine.dispatch(new SomeAction(...))` now: longer, and it names what happens.
  //
  // `app` and `platform` are still passed and are down to four uses between them — the
  // plugin iframe mounts, the media URL machinery, and one registry lookup for a callable.
  // See docs/tickets/009 for why those stay imperative.
  const ui = {
    engine, app, platform,
    // Rendering a cell is a UI concern, not a platform subsystem to reach through.
    watch,
  };

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
      platform.context.observe(),
      platform.settings.observe(),
      app.offline.observe(),
      platform.viewport.observe(),
      platform.voice.observe(),
      // What the UI is in the middle of doing — see bl/viewState.js. Through the engine
      // like everything else now, rather than a module singleton read during a render.
      watchQuery(engine, q.viewState),
      // What the server can do, through the engine rather than off a field on `platform`.
      // Its query declares `initial = null`, so this stays a normal value while the request
      // is in flight instead of turning the whole snapshot PENDING and blanking the shell.
      watchQuery(engine, q.capabilities),
      // Views the shell reads but no region owns yet: the palette's command list, the
      // settings schema, and command id -> keybinding label.
      watchQuery(engine, q.paletteCommands),
      watchQuery(engine, q.commandKeys),
    ],
    // No `_bump` any more. It existed to defeat `watch`'s shallow-equality check for a
    // forced re-render that left no trace in the snapshot — a counter smuggled into the
    // state to get past an optimisation designed to skip pointless renders. With the state
    // that needed it in a cell, every render has a reason again.
    (wb, overlay, nav, ex, se, ctx, settings, off, vp, voice, view, caps, commands, commandKeys) =>
      ({ wb, overlay, nav, ex, se, ctx, settings, off, vp, voice, view, caps, commands, commandKeys }),
  );

  // The chrome, subscribed to what it reads instead of to everything.
  //
  // These four render the same facts in different shapes — `statusFacts` is shared between
  // them — so they share a query set. Splitting them out is what takes `tr` off the main
  // snapshot: an upload progress tick used to invalidate the one watch that builds the whole
  // shell, so moving one number in the transfer tray reconstructed every row of the file
  // list beneath it. Now it reaches the chrome and the tray, and nothing else.
  const chrome = {
    ex: q.explorer, tr: q.transfers, act: q.activity, off: q.offline,
    so: q.social, wb: q.workbench, statusItems: q.statusItems, caps: q.capabilities,
  };
  // A query boots asynchronously — it awaits a container lease first — so a region is
  // PENDING for the first frame or two and `watch` renders its placeholder. For a bar with
  // a fixed height that has to be an empty bar rather than nothing, or the layout jumps
  // once on load and settles.
  const regions = {
    statusBar: region(engine, chrome, (s) => statusBar(s, ui), { placeholder: () => div({ className: 'statusbar' }) }),
    phoneTopBar: region(engine, chrome, (s) => phoneTopBar(s, ui), { placeholder: () => div({ className: 'phonebar top' }) }),
    phoneBottomBar: region(engine, chrome, (s) => phoneBottomBar(s, ui), { placeholder: () => div({ className: 'phonebar bottom' }) }),
    // Both render nothing when there is nothing to show, so an absent first frame is what
    // they would have drawn anyway.
    phoneSheet: region(engine, chrome, (s) => phoneSheet(s, ui)),
    transferTray: region(engine, { tr: q.transfers }, (s) => transferTray(s, ui)),
    // Both read one slice each, and both change often enough to matter: a toast arriving
    // or auto-dismissing used to rebuild the entire shell — including every row of the
    // file list — to add a line in the corner.
    toasts: region(engine, { notif: q.notifications }, (s) => toasts(s, ui)),
    activityPanel: region(engine, { act: q.activity }, (s) => activityPanel(s, ui)),
    // Screens that are usually NOT on screen. Their state still invalidated the shell from
    // wherever they were: minting an API key or a plugin reporting in rebuilt the file
    // list. Each reads a couple of slices, so each is a cheap region.
    settingsView: region(engine, {
      settings: q.settings, settingsGroups: q.settingsGroups, keys: q.apiKeys,
      caps: q.capabilities, ex: q.explorer,
    }, (s) => settingsView(s, ui)),
    pluginsView: region(engine, { plugins: q.plugins, settings: q.settings },
      (s) => pluginsView(s, ui)),
    infoPanel: region(engine, { so: q.social, off: q.offline, nav: q.navigation },
      (s) => infoPanel(s, ui)),
    // The rail. It renders the notification bell and the identity chip, both of which read
    // the social slice — which is how `so` was still reaching the shell after infoPanel
    // moved out. Missed by looking at infoPanel alone; the bell is imported INTO the bar
    // from social.js, so a grep for the component name does not find it.
    activityBar: region(engine, { wb: q.workbench, plugins: q.plugins, so: q.social },
      (s) => activityBar(s, ui)),
    // The palette is the first thing to read a composed view rather than a service's state:
    // `commands` arrives with keybinding labels resolved and availability decided, so the
    // component stopped asking the keybinding and command services anything mid-render.
    commandPalette: region(engine, { overlay: q.overlay, se: q.search, commands: q.paletteCommands },
      (s) => commandPalette(s, ui)),
  };

  return alias(() => watch(combined, (state) => view(state, ui, regions)));
}

function view(state, ui, regions) {
  const mode = state.vp?.mode || 'desktop';
  const phone = mode === 'phone';
  return div({ className: `shell ${mode} ${state.settings['workbench.density'] === 'compact' ? 'compact' : ''}` },
    // On a phone the rail becomes a bottom bar and the status bar folds behind one icon
    // in a top bar — see phoneChrome. Everything between them is identical, which is the
    // point: only the chrome changes shape, not the app.
    phone ? regions.phoneTopBar() : null,
    div({ className: 'body' },
      phone ? null : regions.activityBar(),
      mainArea(state, ui, regions),
    ),
    phone ? regions.phoneBottomBar() : regions.statusBar(),
    phone ? regions.phoneSheet() : null,
    // Overlays.
    searchModal(state, ui),
    regions.commandPalette(),
    dialog(state, ui),
    contextMenu(state, ui),
    pluginPanel(state, ui),
    regions.toasts(),
    regions.transferTray(),
    regions.activityPanel(),
  );
}

function mainArea(state, ui, regions) {
  // Before a collection is known there is nothing to draw: every scoped request names one
  // in its path, so a file list, a search box and an Upload button would all be lying.
  // Settings stays reachable — an admin with no collections still needs to get at it.
  if (state.ex?.gate && state.wb.activity !== 'settings') return collectionGate(state, ui);

  switch (state.wb.activity) {
    case 'settings': return regions.settingsView();
    case 'plugins': return regions.pluginsView();
    default: {
      // Home: the top of the panel stack — the launcher (base search) or, once a
      // file is open, its opener full-width (optionally split with the info panel).
      if (!state.nav.activeTabId) return launcher(state, ui);
      if (!state.wb.infoPanel) return editorArea(state, ui);
      // A 340px rail beside a 390px screen leaves nothing on either side. On a phone the
      // details panel takes the whole panel instead — it has its own close button, so
      // there is still a way back to the file.
      return state.vp?.mode === 'phone'
        ? regions.infoPanel()
        : div({ className: 'editor-split' }, editorArea(state, ui), regions.infoPanel());
    }
  }
}

// Double-shift search: the launcher as a modal overlay. Picking an item resets the
// viewer stack (starts over) — the launcher reads state.wb.searchModal to know.
function searchModal(state, ui) {
  if (!state.wb.searchModal) return div();
  return div({ className: 'search-modal' },
    div({ className: 'scrim' }).on({ click: () => ui.engine.dispatch(new CloseSearchModalAction()) }),
    div({ className: 'search-modal-panel' }, launcher(state, ui, { modal: true })),
  );
}

export { NavigateAction };
