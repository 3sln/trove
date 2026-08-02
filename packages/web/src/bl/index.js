// Assemble the ngin engine: one provider per named resource, then commands, the built-in
// context keys, and the boot dispatches.
//
// There is no `app` provider. It existed, and it made the engine's state one opaque blob —
// every query and every action leased the whole world, and a lease that always covers
// everything tells you nothing about what a piece of work touches or how long it needs it.
// It survived longest as the thing command handlers closed over, and went when they stopped
// being closures (see bl/commands.js). `static deps = ['explorer']` means what it says now,
// and web/test/leases.test.js checks that it stays true.
//
// `app` the OBJECT is still returned, because the shell and the e2e harness hold the
// services directly — but nothing leases it.

import { Engine, Provider } from '@3sln/ngin';
import { cell } from '../runtime.js';
import { registerCoreContext, registerViewportContext } from './context.js';
import { TransfersService } from './services.js';
import { explorerState, searchState, apiKeysState, viewState as viewStateSlice, overlayState, workbenchState, aclState, rotationState } from './state.js';
import { NavigationService } from '../platform/navigation.js';
import { SocialService } from './social.js';
import { OfflineService } from './offline.js';
import { ActivityService } from './activity.js';
import { registerCommands } from './commands.js';
import { NavigateAction } from './actions.js';

export function createApp(platform) {
  // Named slices, not services — see bl/state.js. Each is still its own provider, so a
  // lease naming `explorer` still says what it touches.
  const explorer = explorerState(platform.settings);
  const search = searchState();
  const apiKeys = apiKeysState();
  const rotation = rotationState();
  const acl = aclState();
  // One place for "what's running" and "what's stuck", covering both sides of the wire.
  const activity = new ActivityService(platform);
  // What the UI is in the middle of doing — see bl/state.js. A resource, because it
  // decides what is on screen.
  const viewState = viewStateSlice();
  // The shell, split into what it actually is. `workbench` and `overlay` are slices; the
  // panel stack stays a service, because it mirrors itself into browser history and
  // persists recents — neither of which a state bag can do. The WorkbenchService that used
  // to sit over all three was a 17-method delegation facade, and the provider graph could
  // not see through it: closing a dialog leased the whole shell.
  const workbench = workbenchState();
  const overlay = overlayState();
  const navigation = new NavigationService();
  const transfers = new TransfersService(activity);
  // Offline first: social queues comment and tag writes through it while disconnected, so
  // it is a dependency rather than something bolted on afterwards. It used to be assigned
  // onto `social` after both existed, which reads as optional and is not — a social service
  // built without it silently drops every offline write.
  const offline = new OfflineService(platform);
  const social = new SocialService(platform, offline);

  const app = { platform, explorer, search, transfers, social, offline, activity, apiKeys, rotation, workbench, overlay, navigation, engine: null };

  // Every resource the engine has, named. The engine's STATE is the state of its
  // resources, so the single `app` provider this started with made that state one opaque
  // blob: every query and every action leased the whole world, and a lease that always
  // covers everything tells you nothing about what a piece of work touches or how long it
  // needs it.
  //
  // `app` is gone. It survived longest as the thing command handlers closed over, and went
  // when they stopped being closures — see bl/commands.js. Every lease now names what it
  // touches, and `static deps = ['explorer']` means what it says.
  const engine = new Engine({
    providers: {
      // Where a live query keeps its subscription — see bl/queries.js. A provider, so it
      // is per engine; keyed by the query instance, so an entry belongs to exactly one
      // realization. A query instance is shared (it is interned), so it is the wrong place
      // to put anything that is true only while it is being watched.
      appState: Provider.fromSingleton(new Map()),

      // The drive.
      explorer: Provider.fromSingleton(explorer),
      search: Provider.fromSingleton(search),
      transfers: Provider.fromSingleton(transfers),
      social: Provider.fromSingleton(social),
      offline: Provider.fromSingleton(offline),
      activity: Provider.fromSingleton(activity),
      apiKeys: Provider.fromSingleton(apiKeys),
      rotation: Provider.fromSingleton(rotation),
      acl: Provider.fromSingleton(acl),
      viewState: Provider.fromSingleton(viewState),

      // The engine itself, for actions that choreograph — dispatching a follow-up rather
      // than doing the follow-up's work inline. LAZY because the engine does not exist
      // when its own providers are declared; by the time anything leases this, it does.
      // ngin's execute context carries a dispatchFeed but no dispatcher, so this is the
      // seam for it.
      engine: Provider.fromLazySingleton(async () => engine, () => {}),

      // The shell.
      workbench: Provider.fromSingleton(workbench),
      overlay: Provider.fromSingleton(overlay),
      navigation: Provider.fromSingleton(navigation),
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

      // What this deployment can do: which storage drivers it offers, whether it can
      // suggest searches, how transfers reach the bucket.
      //
      // A PROVIDER, not an action and not a query holding a promise. Nobody asks for
      // capabilities — they are ambient facts other things consult in order to decide, so
      // there is no intent to dispatch and nothing to put on the feed. It was a query that
      // memoised `api.capabilities()` on its own instance to avoid re-fetching, which is a
      // cache with no invalidation living inside a view.
      //
      // It provides a CELL rather than the value, and the fetch is deliberately not
      // awaited. Awaiting would make every lease of this block until the server answered,
      // so a query that merely consults capabilities would be PENDING and the shell would
      // render nothing until the round trip finished. The cell starts null — "not known
      // yet", which every reader already treats correctly — and fills in, so anything
      // watching simply re-projects when the answer lands.
      //
      // One fetch for the life of the page, because `fromLazySingleton` memoises on the
      // creation promise. That is the provider's job, which is where it belongs.
      // Closes over `platform.api` rather than declaring `{ deps: ['api'] }`: a provider's
      // deps arrive as the PROVIDER INSTANCES, not as resources, so the dependency form
      // would hand over something you must `obtain()` and release. Every other provider
      // here closes over what it needs, and this is the same client either way.
      capabilities: Provider.fromLazySingleton(
        async () => {
          const held = cell(null);
          platform.api.capabilities().then(
            (caps) => held.setValue(caps),
            // A drive whose capabilities cannot be read still works; every reader treats
            // null as "not known" and falls back. Failing the provider would take the
            // whole shell down over an optional answer.
            () => {},
          );
          return held;
        },
        () => {},
      ),
      plugins: Provider.fromSingleton(platform.plugins),
    },
  });
  app.engine = engine;

  // How a command reaches the engine. A command resolves to actions and the CommandService
  // dispatches them; it is built with the platform, before the engine exists, so the
  // dispatcher is handed over here.
  //
  // This is the boundary, not a shortcut: a keystroke and a plugin's RPC both originate
  // outside the engine, and one of them has to carry the intent in. Everything past this
  // point is an action on the feed.
  platform.commands.dispatch = (action) => engine.dispatch(action);
  // The same seam for everything that originates outside the engine: a docked plugin frame
  // opening a file, and the plugin RPC asking for its panel. ONE seam — there was a second,
  // `openPluginPanel`, which was `dispatch` with one action pre-applied, declared
  // differently (a field in the platform literal versus one materialising from nowhere) and
  // guarded differently (`dispatch?.()` optional, `openPluginPanel()` not), so a reader
  // looking for how the plugin layer reaches the engine had to find both.
  platform.dispatch = (action) => engine.dispatch(action);

  registerCommands(app);

  // Every built-in when-clause key, derived from the resource it summarises. Registered
  // here because this is where those resources exist; see bl/context.js for the list and
  // for why deriving them is not the same as moving the writes.
  registerCoreContext(platform.context, { workbench, overlay, navigation, explorer });
  registerViewportContext(platform.context, platform.viewport);

  social.init();
  offline.init();
  activity.init();
  // NOT `LoadCollectionsAction` as well. `OpenInitialCollectionAction`, dispatched at boot
  // by workbench.js, fetches and writes the same two fields on both its normal and its
  // share-link path — so every cold start made two identical GETs to /api/collections and
  // installed two writers for one fact.

  return { engine, app };
}

export { NavigateAction };
