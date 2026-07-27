// OverlayService — the shell's transient overlays: the command palette, modal
// dialogs, the right-click context menu, and the plugin popup panel. Extracted from
// WorkbenchService (which kept ~10 concerns); these four are independent of the panel
// stack, so they own their own state + subject. The workbench holds one and delegates,
// coordinating only the Esc/close-topmost ordering (which also spans the stack).

import { cell } from '../runtime.js';

export class OverlayService {
  constructor(context) {
    this.context = context;
    this.state = {
      palette: null, // { mode: 'commands'|'files', query, index } when open
      dialog: null,
      contextMenu: null,
      pluginPanel: null,
    };
    this.cell = cell(this.state);
  }

  observe() {
    return this.cell;
  }
  #set(patch) {
    this.state = { ...this.state, ...patch };
    this.cell.setValue(this.state);
  }

  // --- command palette -------------------------------------------------------
  openPalette(mode = 'commands', query = '') {
    this.#set({ palette: { mode, query, index: 0 } });
    this.context.set('palette.open', true);
  }
  setPaletteQuery(query) {
    if (this.state.palette) this.#set({ palette: { ...this.state.palette, query, index: 0 } });
  }
  movePalette(delta, count) {
    if (!this.state.palette || !count) return;
    this.#set({ palette: { ...this.state.palette, index: wrapIndex(this.state.palette.index, delta, count) } });
  }
  setPaletteIndex(index) {
    if (this.state.palette) this.#set({ palette: { ...this.state.palette, index } });
  }
  closePalette() {
    this.#set({ palette: null });
    this.context.set('palette.open', false);
  }

  // --- dialog ----------------------------------------------------------------
  showDialog(dialog) {
    this.#set({ dialog });
  }
  /** Merge a patch into the open dialog's state (reactive dialogs, e.g. the chooser). */
  updateDialog(patch) {
    if (this.state.dialog) this.#set({ dialog: { ...this.state.dialog, ...patch } });
  }
  closeDialog() {
    this.#set({ dialog: null });
  }

  // --- context menu ----------------------------------------------------------
  showContextMenu(x, y, items) {
    this.#set({ contextMenu: { x, y, items } });
  }
  closeContextMenu() {
    this.#set({ contextMenu: null });
  }

  // --- plugin popup panel ----------------------------------------------------
  openPluginPanel(pluginId) {
    this.#set({ pluginPanel: pluginId });
  }
  closePluginPanel() {
    this.#set({ pluginPanel: null });
  }
}

/** Wrap a list cursor by `delta` within `[0, count)` (shared by the palette + launcher). */
export function wrapIndex(index, delta, count) {
  return (index + delta + count) % count;
}
