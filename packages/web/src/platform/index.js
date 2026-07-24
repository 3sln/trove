// createPlatform — assemble every service into one object the whole app shares.
// This is the "workbench platform": the reactive registries and services that
// core features and plugins both build on. It also registers the default
// settings schema and keybindings so the shell has sensible behaviour out of the
// box. UI-facing shell state (which activity is open, is the palette showing…)
// lives in WorkbenchService; data and mutations go through ngin (see ../bl).

import { reactive } from '../runtime.js';
import { ContributionRegistry } from './contributions.js';
import { ContextKeyService } from './context.js';
import { CommandService } from './commands.js';
import { KeybindingService } from './keybindings.js';
import { SettingsService } from './settings.js';
import { NotificationService } from './notifications.js';
import { TroveApiClient } from './api.js';
import { PluginHost } from './pluginHost.js';
import { WorkbenchService } from './workbench.js';

export function createPlatform({ baseUrl = '' } = {}) {
  const contributions = new ContributionRegistry();
  const context = new ContextKeyService({ 'view.active': 'explorer', 'sidebar.visible': true });
  const notifications = new NotificationService();
  const commands = new CommandService(contributions, context, notifications);
  const keybindings = new KeybindingService(contributions, commands, context);
  const settings = new SettingsService();
  const api = new TroveApiClient({ baseUrl });
  const workbench = new WorkbenchService(context);

  const platform = {
    reactive,
    contributions, context, commands, keybindings, settings, notifications, api, workbench,
    capabilities: null,
    openPluginPanel: null, // set by the workbench UI
  };
  platform.plugins = new PluginHost(platform);
  // Commands consult the plugin host to hide/disable plugin commands that aren't
  // available right now (offline, or the plugin isn't responding).
  commands.availability = (cmd) => platform.plugins.isAvailable(cmd);

  registerDefaults(platform);
  return platform;
}

function registerDefaults(p) {
  // --- default settings schema ----------------------------------------------
  p.settings.register([
    { key: 'workbench.theme', type: 'enum', enum: ['dark', 'light', 'midnight'], enumLabels: ['Dark', 'Light', 'Midnight'], default: 'dark', title: 'Color theme', category: 'Appearance', order: 1 },
    { key: 'workbench.density', type: 'enum', enum: ['comfortable', 'compact'], default: 'comfortable', title: 'List density', category: 'Appearance', order: 2 },
    { key: 'explorer.sort', type: 'enum', enum: ['name', 'size', 'updatedAt'], enumLabels: ['Name', 'Size', 'Modified'], default: 'name', title: 'Sort files by', category: 'Explorer', order: 1 },
    { key: 'explorer.sortOrder', type: 'enum', enum: ['asc', 'desc'], default: 'asc', title: 'Sort order', category: 'Explorer', order: 2 },
    { key: 'explorer.confirmDelete', type: 'boolean', default: true, title: 'Confirm before deleting', category: 'Explorer', order: 3 },
    { key: 'search.mode', type: 'enum', enum: ['hybrid', 'semantic', 'keyword'], default: 'hybrid', title: 'Search mode', description: 'Hybrid blends semantic meaning with keyword matches.', category: 'Search', order: 1 },
    { key: 'uploads.concurrency', type: 'number', minimum: 1, maximum: 8, default: 4, title: 'Parallel upload parts', category: 'Transfers', order: 1 },
  ]);

  // --- default keybindings (commands are registered in ../bl) ---------------
  const kb = [
    { key: 'mod+shift+p', command: 'workbench.showCommandPalette' },
    { key: 'mod+p', command: 'workbench.quickOpen' },
    { key: 'mod+shift+f', command: 'workbench.view.home' },
    { key: 'mod+shift+e', command: 'workbench.view.home' },
    { key: 'mod+,', command: 'workbench.openSettings' },
    { key: 'mod+shift+n', command: 'explorer.newFolder' },
    { key: 'mod+u', command: 'explorer.upload' },
    { key: 'delete', command: 'explorer.delete', when: "view.active == 'home' && explorer.hasSelection" },
    { key: 'escape', command: 'workbench.closeOverlays' },
    { key: 'f5', command: 'explorer.refresh' },
    { key: 'mod+shift+i', command: 'workbench.toggleInfoPanel' },
  ];
  for (const b of kb) p.contributions.keybindings.register(b);
}
