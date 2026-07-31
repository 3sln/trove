// CommandService — the one way anything happens in the workbench. Buttons,
// menu items, keybindings, the palette, and plugins all funnel through
// `execute(id, ...args)`. A command's metadata (title/category/icon/when/palette)
// lives in the contribution registry; its handler lives here (core handlers are
// plain functions, plugin handlers proxy over RPC). Errors surface as a
// notification instead of a silent console log — failure is always visible.

export class CommandService {
  /**
   * @param {import('./contributions.js').ContributionRegistry} contributions
   * @param {import('./context.js').ContextKeyService} context
   * @param {import('./notifications.js').NotificationService} notifications
   */
  constructor(contributions, context, notifications) {
    this.contributions = contributions;
    this.context = context;
    this.notifications = notifications;
    this.handlers = new Map(); // id -> (...args) => Action | Action[] | null
    // How a resolved command reaches the engine. Filled in by createApp, because this
    // service is built with the rest of the platform and the engine does not exist yet.
    //
    // It is a seam rather than a smell: keystrokes and plugin RPC arrive from outside the
    // engine and something has to carry them in. Until it is set, a command says so instead
    // of silently doing nothing.
    this.dispatch = () => {
      throw new Error('CommandService has no dispatcher yet — see createApp');
    };
  }

  /**
   * Register a command. Accepts either register(id, actions) or a full spec object
   * { id, title, actions, category, icon, when, palette }.
   *
   * `actions` is a PURE FACTORY: `(...args) => Action | Action[] | null`. It is not a
   * handler, and the difference is the point — a handler did the work, which meant every
   * menu item, keybinding and palette entry a person triggered went around the engine. A
   * factory only says what should be dispatched, and `execute` dispatches it.
   */
  register(idOrSpec, actions) {
    const spec = typeof idOrSpec === 'string' ? { id: idOrSpec, actions } : idOrSpec;
    if (spec.actions) this.handlers.set(spec.id, spec.actions);
    const dispose = this.contributions.register(spec.id, {
      type: 'command',
      title: spec.title ?? spec.id,
      category: spec.category,
      icon: spec.icon,
      when: spec.when,
      palette: spec.palette ?? true,
      // Provenance + offline capability, for availability filtering.
      pluginId: spec.pluginId,
      offline: spec.offline,
    });
    return () => {
      this.handlers.delete(spec.id);
      dispose();
    };
  }

  has(id) {
    return this.handlers.has(id);
  }

  isEnabled(id) {
    const cmd = this.contributions.get(id);
    if (cmd?.when && !this.context.evaluate(cmd.when)) return false;
    return this.isAvailable(cmd);
  }

  /** A command is available unless it's a plugin command that's currently offline/dead. */
  isAvailable(cmd) {
    if (!cmd) return true;
    return this.availability ? this.availability(cmd) : true;
  }

  /**
   * Run a command: resolve what it means, then dispatch it.
   *
   * The gating stays here rather than moving into an action, because it is the same three
   * questions for every command however it was triggered — does it exist, is the plugin
   * behind it answering, does its when-clause hold — and answering them in one place is
   * what keeps a keybinding and a palette entry behaving identically.
   *
   * What is NOT here any more is the work. `actions` returns descriptions and this
   * dispatches them, so the engine sees the command AND everything it causes.
   */
  async execute(id, ...args) {
    const actionsFor = this.handlers.get(id);
    if (!actionsFor) {
      this.notifications.error(`Command not found: ${id}`);
      return;
    }
    const cmd = this.contributions.get(id);
    if (!this.isAvailable(cmd)) {
      this.notifications.warn(`“${cmd?.title || id}” isn’t available${this.availability ? ' offline' : ''} right now.`);
      return;
    }
    if (!this.isEnabled(id)) return; // gated by when-clause
    try {
      const actions = actionsFor(...args);
      if (!actions) return;
      // One at a time, each genuinely finished before the next begins.
      //
      // `dispatch` answers an event FEED, not a promise for the work — awaiting it resolves
      // immediately and the action runs afterwards, so a bare `await dispatch(a)` in a loop
      // would start all of them at once while looking like it sequenced them. `next` on the
      // terminal events is the actual completion signal.
      //
      // It resolves with whichever of complete/error/abort fired rather than rejecting, so
      // a failing action does not throw here — but it does stop the rest, because a command
      // whose first step failed rarely wants its second.
      for (const action of [].concat(actions)) {
        const settled = await this.dispatch(action).next(['complete', 'error', 'abort']);
        if (settled?.type !== 'complete') break;
      }
    } catch (err) {
      console.error(`Command ${id} failed`, err);
      this.notifications.error(err?.message || `Command failed: ${id}`);
      throw err;
    }
  }

  /** Commands eligible for the palette right now (respecting when-clauses). */
  paletteCommands() {
    return this.contributions
      .ofType('command')
      .filter((c) => c.palette !== false && (!c.when || this.context.evaluate(c.when)))
      .sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.title.localeCompare(b.title));
  }
}
