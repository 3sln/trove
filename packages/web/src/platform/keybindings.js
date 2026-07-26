// KeybindingService — turns keystrokes into command executions, honouring
// when-clauses and chords (multi-key sequences like "ctrl+k ctrl+s").
//
// Bindings come from `keymap` CONTRIBUTIONS: the host contributes one built-in keymap,
// and a plugin contributes one by declaring `{ type: 'keymap', path: 'keymaps/x.json' }`
// in its manifest (the host reads and validates that file at install). So core and
// plugins share exactly one keymap and the shortcuts UI can render all of it.
// User rebinds live in settings under `keybindings.overrides` (command -> key) and win
// over whatever a keymap declared. Typing in an input is respected: only bindings with
// a modifier (or Escape) fire while editing.

export const OVERRIDES_KEY = 'keybindings.overrides';

export function normalizeKey(str) {
  // Canonical form: sorted modifiers + key, lowercased. "Cmd+Shift+P" → "meta+shift+p"
  const parts = str.trim().toLowerCase().split('+').map((p) => p.trim());
  const mods = new Set();
  let key = '';
  for (const p of parts) {
    if (['ctrl', 'control'].includes(p)) mods.add('ctrl');
    else if (['cmd', 'meta', 'super', 'win'].includes(p)) mods.add('meta');
    else if (p === 'alt' || p === 'option') mods.add('alt');
    else if (p === 'shift') mods.add('shift');
    else if (['ctrlcmd', 'mod'].includes(p)) mods.add(isMac() ? 'meta' : 'ctrl');
    else key = p;
  }
  const order = ['ctrl', 'meta', 'alt', 'shift'];
  return [...order.filter((m) => mods.has(m)), key].filter(Boolean).join('+');
}

export function eventToKey(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.metaKey) mods.push('meta');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  let key = e.key.toLowerCase();
  const named = { ' ': 'space', escape: 'escape', enter: 'enter', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right' };
  key = named[key] || key;
  return [...mods.filter((m) => key !== m), key].join('+');
}

export class KeybindingService {
  /**
   * @param {import('./contributions.js').ContributionRegistry} contributions
   * @param {import('./commands.js').CommandService} commands
   * @param {import('./context.js').ContextKeyService} context
   * @param {import('./settings.js').SettingsService} [settings] source of user rebinds
   */
  constructor(contributions, commands, context, settings = null) {
    this.contributions = contributions;
    this.commands = commands;
    this.context = context;
    this.settings = settings;
    this.chordPrefix = null;
    this.chordTimer = null;
    this._onKeyDown = this.#onKeyDown.bind(this);
  }

  install(target = window) {
    target.addEventListener('keydown', this._onKeyDown);
    return () => target.removeEventListener('keydown', this._onKeyDown);
  }

  /**
   * User rebinds, keyed by BINDING rather than by command.
   *
   * Keyed by command, one shortcut could not be changed without changing the others:
   * `workbench.view.home` ships bound twice (⌘⇧F and ⌘⇧E), so rebinding either
   * collapsed both onto the new chord — two identical rows in Settings and one shortcut
   * silently gone. A binding's identity is (command, the key it was DECLARED with),
   * which is stable across restarts and unique per row.
   */
  overrides() {
    return this.settings?.get(OVERRIDES_KEY) || {};
  }

  /** The override key for one declared binding. */
  static bindingId(binding) {
    return `${binding.command}\u0000${normalizeKey(binding.defaultKey || binding.key)}`;
  }

  /**
   * Rebind one BINDING (null clears it back to what its keymap declared).
   * @param {{command: string, defaultKey?: string, key: string}|string} binding
   *   a resolved binding, or a bare command id for the legacy single-binding case.
   */
  rebind(binding, key) {
    if (!this.settings) return;
    const id = typeof binding === 'string'
      ? this.#idForCommand(binding)
      : KeybindingService.bindingId(binding);
    if (!id) return;
    const next = { ...this.overrides() };
    if (key) next[id] = key; else delete next[id];
    this.settings.set(OVERRIDES_KEY, next);
  }

  /** Resolve a bare command id to its (single) binding id, for older callers. */
  #idForCommand(command) {
    const b = this.contributions.keybindings().find((x) => x?.command === command && x.key);
    return b ? KeybindingService.bindingId({ ...b, defaultKey: b.key }) : null;
  }

  /** Current effective bindings (every keymap's, plus user overrides). */
  resolved() {
    const overrides = this.overrides();
    return this.contributions.keybindings()
      .filter((b) => b?.key && b.command)
      .map((b) => {
        // `defaultKey` is what the keymap declared — the row's stable identity, and what
        // "reset" restores to.
        const defaultKey = normalizeKey(b.key);
        const id = KeybindingService.bindingId({ command: b.command, defaultKey });
        return { ...b, defaultKey, bindingId: id, key: normalizeKey(overrides[id] || b.key) };
      });
  }

  #matchFor(keyChord) {
    const snapshot = this.context.snapshot();
    // Later registrations win (plugins can override), so scan in reverse.
    const list = this.resolved();
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if (b.key !== keyChord) continue;
      if (b.when && !this.context.evaluate(b.when)) continue;
      return b;
    }
    return null;
  }

  #onKeyDown(e) {
    if (e.defaultPrevented) return;
    const chord = eventToKey(e);
    const hasMod = e.ctrlKey || e.metaKey || e.altKey;
    const typing = isTyping(e.target);

    // While typing, only modifier chords and Escape are eligible (don't eat text).
    if (typing && !hasMod && e.key !== 'Escape') {
      this.#resetChord();
      return;
    }

    const full = this.chordPrefix ? `${this.chordPrefix} ${chord}` : chord;
    const binding = this.#matchFor(full);

    if (binding) {
      e.preventDefault();
      this.#resetChord();
      this.commands.execute(binding.command, ...(binding.args || []));
      return;
    }

    // Could this be the first key of a chord?
    if (!this.chordPrefix && this.resolved().some((b) => b.key.startsWith(chord + ' '))) {
      e.preventDefault();
      this.chordPrefix = chord;
      this.chordTimer = setTimeout(() => this.#resetChord(), 1500);
      return;
    }
    this.#resetChord();
  }

  #resetChord() {
    this.chordPrefix = null;
    if (this.chordTimer) clearTimeout(this.chordTimer);
    this.chordTimer = null;
  }

  /** Human-readable label for a command's binding, for menus/tooltips. */
  labelFor(command) {
    const b = this.resolved().find((x) => x.command === command);
    return b ? prettyKey(b.key) : null;
  }
}

function isTyping(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
function isMac() {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '');
}
export function prettyKey(key) {
  const mac = isMac();
  const map = mac
    ? { ctrl: '⌃', meta: '⌘', alt: '⌥', shift: '⇧', enter: '↵', escape: 'esc', up: '↑', down: '↓', left: '←', right: '→', space: '␣' }
    : { ctrl: 'Ctrl', meta: 'Win', alt: 'Alt', shift: 'Shift', enter: 'Enter', escape: 'Esc', up: '↑', down: '↓', left: '←', right: '→', space: 'Space' };
  return key
    .split(' ')
    .map((chord) =>
      chord
        .split('+')
        .map((p) => map[p] || (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
        .join(mac ? '' : '+'),
    )
    .join(' ');
}
