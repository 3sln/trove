// Assemble the ngin engine and the reactive services into one `app` context,
// register commands and built-in openers, and expose everything the UI needs.
// The engine holds a single `app` singleton provider so Actions can reach the
// platform and services; the app object also carries the engine so Actions can
// dispatch follow-up Actions (the choreographer pattern).

import { Engine, Provider } from '@3sln/ngin';
import { effect } from '../runtime.js';
import { ExplorerService, SearchClientService, TransfersService, ApiKeysService } from './services.js';
import { SocialService } from './social.js';
import { OfflineService } from './offline.js';
import { ActivityService } from './activity.js';
import { ViewStateService } from './viewState.js';
import { registerCommands } from './commands.js';
import { NavigateAction, LoadCollectionsAction, OpenInitialCollectionAction } from './actions.js';

export function createApp(platform) {
  const explorer = new ExplorerService(platform.settings);
  const search = new SearchClientService();
  const apiKeys = new ApiKeysService();
  // One place for "what's running" and "what's stuck", covering both sides of the wire.
  const activity = new ActivityService(platform);
  // What the UI is in the middle of doing — see viewState.js. A resource, because it
  // decides what is on screen.
  const viewState = new ViewStateService();
  const transfers = new TransfersService(activity);
  const social = new SocialService(platform);
  const offline = new OfflineService(platform);
  social.offline = offline; // social queues sidecar ops through offline when disconnected

  const app = { platform, explorer, search, transfers, social, offline, activity, apiKeys, engine: null };

  // Every resource the engine has, named. The engine's STATE is the state of its
  // resources, so a single `app` provider made that state one opaque blob: every query and
  // every action leased the whole world, and a lease that always covers everything tells
  // you nothing about what a piece of work touches or how long it needs it.
  //
  // Named individually, `static deps = ['explorer']` means what it says. `app` is still
  // here because the older actions reach across several of these at once and are converted
  // as they are touched, not in one sweep — but nothing NEW should ask for it.
  const engine = new Engine({
    providers: {
      app: Provider.fromSingleton(app),

      // The drive.
      explorer: Provider.fromSingleton(explorer),
      search: Provider.fromSingleton(search),
      transfers: Provider.fromSingleton(transfers),
      social: Provider.fromSingleton(social),
      offline: Provider.fromSingleton(offline),
      activity: Provider.fromSingleton(activity),
      apiKeys: Provider.fromSingleton(apiKeys),
      viewState: Provider.fromSingleton(viewState),

      // The shell.
      workbench: Provider.fromSingleton(platform.workbench),
      settings: Provider.fromSingleton(platform.settings),
      notifications: Provider.fromSingleton(platform.notifications),
      context: Provider.fromSingleton(platform.context),
      commands: Provider.fromSingleton(platform.commands),
      keybindings: Provider.fromSingleton(platform.keybindings),
      contributions: Provider.fromSingleton(platform.contributions),
      viewport: Provider.fromSingleton(platform.viewport),
      voice: Provider.fromSingleton(platform.voice),

      // The outside world.
      api: Provider.fromSingleton(platform.api),
      mediaUrls: Provider.fromSingleton(platform.mediaUrls),
      plugins: Provider.fromSingleton(platform.plugins),
    },
  });
  app.engine = engine;

  registerCommands(app);

  // Wire the plugin panel opener hook to the workbench.
  platform.openPluginPanel = (pluginId) => platform.workbench.openPluginPanel(pluginId);

  // Project explorer state → context keys in ONE place. These drive when-clauses
  // (e.g. the Delete keybinding needs `explorer.hasSelection`), and previously only
  // NavigateAction set them — so selecting a file never flipped hasSelection true and
  // Delete silently did nothing. Deriving them from the observable keeps them honest.
  //
  // `null` when no collection is open, never the string 'default'. A when-clause reading
  // this is asking which collection is open, and answering with the name of one that may
  // not exist made every such clause true before the user had chosen anything.
  platform.context.setMany({ 'explorer.collectionId': null, 'explorer.hasSelection': false });
  effect(explorer.observe(), (ex) => {
    platform.context.setMany({
      'explorer.collectionId': ex.collectionId ?? null,
      'explorer.hasSelection': (ex.selection?.length || 0) > 0,
    });
  });

  // Load a file's conversation/tags whenever the active viewer panel changes (the
  // panel stack lives in the navigation sub-service now).
  let lastTab = null;
  effect(platform.workbench.observeNav(), (nav) => {
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
