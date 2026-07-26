// Assemble the ngin engine and the reactive services into one `app` context,
// register commands and built-in openers, and expose everything the UI needs.
// The engine holds a single `app` singleton provider so Actions can reach the
// platform and services; the app object also carries the engine so Actions can
// dispatch follow-up Actions (the choreographer pattern).

import { Engine, Provider } from '@3sln/ngin';
import { ExplorerService, SearchClientService, TransfersService } from './services.js';
import { SocialService } from './social.js';
import { OfflineService } from './offline.js';
import { ActivityService } from './activity.js';
import { registerCommands } from './commands.js';
import { NavigateAction, LoadCollectionsAction, OpenInitialCollectionAction } from './actions.js';

export function createApp(platform) {
  const explorer = new ExplorerService(platform.settings);
  const search = new SearchClientService();
  // One place for "what's running" and "what's stuck", covering both sides of the wire.
  const activity = new ActivityService(platform);
  const transfers = new TransfersService(activity);
  const social = new SocialService(platform);
  const offline = new OfflineService(platform);
  social.offline = offline; // social queues sidecar ops through offline when disconnected

  const app = { platform, explorer, search, transfers, social, offline, activity, engine: null };

  const engine = new Engine({
    providers: { app: Provider.fromSingleton(app) },
  });
  app.engine = engine;

  registerCommands(app);

  // Wire the plugin panel opener hook to the workbench.
  platform.openPluginPanel = (pluginId) => platform.workbench.openPluginPanel(pluginId);

  // Project explorer state → context keys in ONE place. These drive when-clauses
  // (e.g. the Delete keybinding needs `explorer.hasSelection`), and previously only
  // NavigateAction set them — so selecting a file never flipped hasSelection true and
  // Delete silently did nothing. Deriving them from the observable keeps them honest.
  platform.context.setMany({ 'explorer.collectionId': 'default', 'explorer.hasSelection': false });
  explorer.observe().subscribe((ex) => {
    platform.context.setMany({
      'explorer.collectionId': ex.collectionId || 'default',
      'explorer.hasSelection': (ex.selection?.length || 0) > 0,
    });
  });

  // Load a file's conversation/tags whenever the active viewer panel changes (the
  // panel stack lives in the navigation sub-service now).
  let lastTab = null;
  platform.workbench.observeNav().subscribe((nav) => {
    if (nav.activeTabId !== lastTab) {
      lastTab = nav.activeTabId;
      // Clear the sidecar when no file is active (last tab closed) so a stale
      // conversation from the previous file doesn't linger.
      social.loadSidecar(nav.activeFile ? nav.activeFile.id : null);
    }
  });

  social.init();
  offline.init();
  activity.init();
  engine.dispatch(new LoadCollectionsAction());

  return { engine, app };
}

export { NavigateAction };
