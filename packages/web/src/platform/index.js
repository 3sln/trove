// createPlatform — assemble every service into one object the whole app shares.
// This is the "workbench platform": the reactive registries and services that
// core features and plugins both build on. It also registers the default
// settings schema and keybindings so the shell has sensible behaviour out of the
// box. UI-facing shell state (which activity is open, is the palette showing…)
// lives in WorkbenchService; data and mutations go through ngin (see ../bl).

import { reactive } from '../runtime.js';
import { ContributionRegistry } from './contributions.js';
import { ContextRegistry } from './context.js';
import { CommandService } from './commands.js';
import { KeybindingService } from './keybindings.js';
import { SettingsService } from './settings.js';
import { NotificationService } from './notifications.js';
import { TroveApiClient } from './api.js';
import { PluginHost } from './pluginHost.js';
import { WorkbenchService } from './workbench.js';
import { ViewportService } from './viewport.js';
import { SpatialNavigationService } from './spatialNav.js';
import { VoiceSearchService } from './voiceSearch.js';
import { MediaUrlService } from './mediaUrls.js';

/**
 * The bearer token for this browser, if any.
 *
 * `localStorage` rather than a cookie because the token is presented as an
 * Authorization header, not sent ambiently — which is what makes CSRF a non-issue here.
 * Wrapped in try/catch because storage access throws outright in some privacy modes,
 * and a drive that white-screens because it couldn't read a key that is usually absent
 * would be a poor trade.
 */
export function readToken() {
  try { return localStorage.getItem('trove.token') || null; } catch { return null; }
}
/** Store (or clear, with null) the bearer token this browser presents. */
export function writeToken(token) {
  try {
    if (token) localStorage.setItem('trove.token', token);
    else localStorage.removeItem('trove.token');
  } catch { /* storage unavailable; the session is simply not persisted */ }
}

export function createPlatform({ baseUrl = '' } = {}) {
  const contributions = new ContributionRegistry();
  // Only the fixed facts are seeded. Everything else is registered by whoever owns it —
  // the built-in keys are derived from the shell and the drive (see bl/context.js), so
  // there is nothing sensible to pre-fill them with and nothing that would go stale if
  // there were.
  //
  // It used to be seeded with `view.active: 'home'` for a reason worth remembering: nothing
  // wrote that key until the user navigated, so every `when: view.active == 'home'`
  // binding — the Delete shortcut among them — was dead from boot until the first click on
  // the rail, while the row menu cheerfully advertised "Del" as the way to delete. A
  // derived key is never unwritten, so the seed is not needed and cannot drift from the
  // state it was standing in for.
  const context = new ContextRegistry();
  const notifications = new NotificationService();
  const commands = new CommandService(contributions, context, notifications);
  const settings = new SettingsService();
  const keybindings = new KeybindingService(contributions, commands, context, settings);
  // A bearer token, when this deployment uses one. Most don't: an authenticating proxy
  // (Cloudflare Access, oauth2-proxy) sets its own header and the browser sends nothing.
  // But a deployment where the user HOLDS a token has no other way to present it, and
  // reading it here — once, from one place — keeps that out of every call site.
  const api = new TroveApiClient({ baseUrl, token: () => readToken() });
  const workbench = new WorkbenchService();
  // Which shell to render — phone, desktop, or TV. Constructed before the defaults are
  // registered, so it reads the setting through `settings.get` once that exists.
  const viewport = new ViewportService({ settings });
  // Arrow keys → geometry, but only on a TV. Inert everywhere else.
  const spatialNav = new SpatialNavigationService({ workbench, viewport });
  // Speak to search. Mostly this just puts the search field under the remote's mic —
  // see voiceSearch.js for why that is the whole feature on a TV.
  const voice = new VoiceSearchService({ workbench, notifications, settings });

  const platform = {
    reactive,
    contributions, context, commands, keybindings, settings, notifications, api, workbench,
    viewport, spatialNav, voice,
  };
  platform.mediaUrls = new MediaUrlService({ api: platform.api, settings });
  platform.plugins = new PluginHost(platform);
  // Commands consult the plugin host to hide/disable plugin commands that aren't
  // available right now (offline, or the plugin isn't responding).
  commands.availability = (cmd) => platform.plugins.isAvailable(cmd);

  registerDefaults(platform);
  // Defaults are in place now, so re-measure: `workbench.layout` was unreadable a moment
  // ago and a forced layout must not need a resize to take effect.
  viewport.refresh();
  return platform;
}

function registerDefaults(p) {
  // --- default settings schema ----------------------------------------------
  p.settings.register([
    { key: 'workbench.theme', type: 'enum', enum: ['dark', 'light', 'midnight'], enumLabels: ['Dark', 'Light', 'Midnight'], default: 'dark', title: 'Color theme', category: 'Appearance', order: 1 },
    { key: 'workbench.density', type: 'enum', enum: ['comfortable', 'compact'], default: 'comfortable', title: 'List density', category: 'Appearance', order: 2 },
    // Auto gets it right for phones and desktops. TVs are the reason this is a setting:
    // a browser on a set-top box usually looks like a large desktop, so someone using
    // one with a remote needs a way to say so.
    { key: 'workbench.layout', type: 'enum', enum: ['auto', 'desktop', 'phone', 'tv'],
      enumLabels: ['Automatic', 'Desktop', 'Phone', 'TV / remote'], default: 'auto',
      title: 'Layout', description: 'Automatic follows the screen size. Choose TV for d-pad remote navigation.',
      category: 'Appearance', order: 3 },
    { key: 'explorer.sort', type: 'enum', enum: ['name', 'size', 'updatedAt'], enumLabels: ['Name', 'Size', 'Modified'], default: 'name', title: 'Sort files by', category: 'Explorer', order: 1 },
    { key: 'explorer.sortOrder', type: 'enum', enum: ['asc', 'desc'], default: 'asc', title: 'Sort order', category: 'Explorer', order: 2 },
    { key: 'explorer.confirmDelete', type: 'boolean', default: true, title: 'Confirm before deleting', category: 'Explorer', order: 3 },
    { key: 'search.mode', type: 'enum', enum: ['hybrid', 'semantic', 'keyword'], default: 'hybrid', title: 'Search mode', description: 'Hybrid blends semantic meaning with keyword matches.', category: 'Search', order: 1 },
    { key: 'uploads.concurrency', type: 'number', minimum: 1, maximum: 8, default: 4, title: 'Parallel upload parts', category: 'Transfers', order: 1 },
    // Which viewer opens which file type. When several openers match a file and there
    // is no entry here, the user is asked (and can save their answer) — see bl/openers.
    // Markdown ships with an answer already: it matches both the markdown renderer and
    // the plain-text viewer, and since documents are how things are grouped now,
    // prompting on every first .md would be friction over a decision that's obvious.
    // It stays changeable in Settings, and the text viewer is still reachable through
    // the opener switcher.
    { key: 'openers.associations', type: 'object', hidden: true, title: 'Default viewers',
      default: { '.md': 'core.markdown', '.markdown': 'core.markdown' } },
    // How results are drawn (see ui/components/views). Hidden and with no default on
    // purpose: unset means "you decide", and the launcher then offers the grid by itself
    // for a collection full of pictures. Picking one in the switcher pins it.
    { key: 'explorer.view', type: 'string', hidden: true, title: 'Results view' },
    // Whether media fetches use a URL that carries its own grant (see
    // platform/mediaUrls.js). `auto` mints only where the browser cannot authenticate
    // itself, which is the right answer almost everywhere — hence hidden.
    { key: 'media.signedUrls', type: 'enum', enum: ['auto', 'always', 'never'], default: 'auto',
      hidden: true, title: 'Signed media URLs' },
  ]);

  // --- the built-in keymap (commands themselves are registered in ../bl) -----
  // One `keymap` contribution, exactly like a plugin's — the host has no privileged
  // path into the keybinding service.
  p.contributions.register('keymap.default', {
    type: 'keymap',
    bindings: [
      { key: 'mod+shift+p', command: 'workbench.showCommandPalette' },
      { key: 'mod+p', command: 'workbench.quickOpen' },
      { key: 'mod+shift+f', command: 'workbench.view.home' },
      { key: 'mod+shift+e', command: 'workbench.view.home' },
      { key: 'mod+,', command: 'workbench.openSettings' },
      { key: 'mod+shift+l', command: 'explorer.copyLink' },
      { key: 'mod+u', command: 'explorer.upload' },
      { key: 'delete', command: 'explorer.delete', when: "view.active == 'home' && explorer.hasSelection" },
      { key: 'escape', command: 'workbench.closeOverlays' },
      { key: 'f5', command: 'explorer.refresh' },
      { key: 'mod+shift+i', command: 'workbench.toggleInfoPanel' },
      // Some remotes and keyboards send a dedicated search key; where they do, it lands
      // on the one command that opens the search field ready for dictation.
      { key: 'mod+shift+v', command: 'search.voice' },
      { key: 'browsersearch', command: 'search.voice' },
    ],
  });
}
