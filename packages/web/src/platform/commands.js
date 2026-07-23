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
    this.handlers = new Map(); // id -> fn
  }

  /**
   * Register a command. Accepts either register(id, handler) or a full spec
   * object { id, title, handler, category, icon, when, palette }.
   */
  register(idOrSpec, handler) {
    const spec = typeof idOrSpec === 'string' ? { id: idOrSpec, handler } : idOrSpec;
    if (spec.handler) this.handlers.set(spec.id, spec.handler);
    const dispose = this.contributions.commands.register({
      id: spec.id,
      title: spec.title ?? spec.id,
      category: spec.category,
      icon: spec.icon,
      when: spec.when,
      palette: spec.palette ?? true,
    });
    return () => {
      this.handlers.delete(spec.id);
      dispose();
    };
  }

  /** Register just a handler for an already-declared command (plugin path). */
  registerHandler(id, handler) {
    this.handlers.set(id, handler);
    return () => this.handlers.delete(id);
  }

  has(id) {
    return this.handlers.has(id);
  }

  isEnabled(id) {
    const cmd = this.contributions.commands.get(id);
    return !cmd?.when || this.context.evaluate(cmd.when);
  }

  async execute(id, ...args) {
    const handler = this.handlers.get(id);
    if (!handler) {
      this.notifications.error(`Command not found: ${id}`);
      return;
    }
    if (!this.isEnabled(id)) return; // gated by when-clause
    try {
      return await handler(...args);
    } catch (err) {
      console.error(`Command ${id} failed`, err);
      this.notifications.error(err?.message || `Command failed: ${id}`);
      throw err;
    }
  }

  /** Commands eligible for the palette right now (respecting when-clauses). */
  paletteCommands() {
    return this.contributions.commands
      .all()
      .filter((c) => c.palette !== false && (!c.when || this.context.evaluate(c.when)))
      .sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.title.localeCompare(b.title));
  }
}
