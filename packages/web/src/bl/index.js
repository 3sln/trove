// Assemble the ngin engine and the reactive services into one `app` context,
// register commands and built-in openers, and expose everything the UI needs.
// The engine holds a single `app` singleton provider so Actions can reach the
// platform and services; the app object also carries the engine so Actions can
// dispatch follow-up Actions (the choreographer pattern).

import { Engine, Provider } from '@3sln/ngin';
import { ExplorerService, SearchClientService, TransfersService } from './services.js';
import { registerCommands } from './commands.js';
import { NavigateAction } from './actions.js';
import { registerBuiltinOpeners } from '../ui/components/openers/index.js';

export function createApp(platform) {
  const explorer = new ExplorerService(platform.settings);
  const search = new SearchClientService();
  const transfers = new TransfersService();

  const app = { platform, explorer, search, transfers, engine: null };

  const engine = new Engine({
    providers: { app: Provider.fromSingleton(app) },
  });
  app.engine = engine;

  registerCommands(app);
  registerBuiltinOpeners(platform);

  // Wire the plugin panel opener hook to the workbench.
  platform.openPluginPanel = (pluginId) => platform.workbench.openPluginPanel(pluginId);

  return { engine, app };
}

export { NavigateAction };
