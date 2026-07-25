// WorkbenchService — the shell's ephemeral UI state (not the file data, which
// ngin owns). The main panel is a STACK of panels: the base is the root search
// (launcher); opening a file pushes a viewer panel; back pops. The stack is mirrored
// into the browser history (pushState/popState) so back/forward navigate it. A
// double-shift opens a modal search overlay; picking from it resets the stack.
// It also mirrors key bits into the ContextKeyService for when-clauses.

import { ObservableSubject } from '../runtime.js';
import { OverlayService, wrapIndex } from './overlay.js';

const RECENTS_KEY = 'trove.recents';
const RECENTS_MAX = 12;

export class WorkbenchService {
  constructor(context) {
    this.context = context;
    // Transient overlays (palette/dialog/contextMenu/pluginPanel) own their own state;
    // the workbench delegates to this and coordinates the Esc close-order below.
    this.overlay = new OverlayService(context);
    this.state = {
      activity: 'home', // home (stack) | plugins | settings
      sidebarVisible: true,
      launch: { query: '', index: 0 }, // the launcher's query
      searchModal: false, // the double-shift modal search overlay
      stack: [{ kind: 'search' }], // [{kind:'search'}, {kind:'file', id, node, openerId}, …]
      activeTabId: null, // top file panel id (or null)
      activeFile: null, // top file panel node (or null)
      recents: loadRecents(),
      infoPanel: false,
    };
    this.subject = new ObservableSubject(this.state);
  }

  observe() {
    return this.subject;
  }
  observeOverlay() {
    return this.overlay.observe();
  }
  #set(patch) {
    this.state = { ...this.state, ...patch };
    this.subject.next(this.state);
  }

  // --- overlay delegations (state lives in OverlayService) -------------------
  openPalette(mode, query) { this.overlay.openPalette(mode, query); }
  setPaletteQuery(query) { this.overlay.setPaletteQuery(query); }
  movePalette(delta, count) { this.overlay.movePalette(delta, count); }
  setPaletteIndex(index) { this.overlay.setPaletteIndex(index); }
  closePalette() { this.overlay.closePalette(); }
  showDialog(dialog) { this.overlay.showDialog(dialog); }
  updateDialog(patch) { this.overlay.updateDialog(patch); }
  closeDialog() { this.overlay.closeDialog(); }
  showContextMenu(x, y, items) { this.overlay.showContextMenu(x, y, items); }
  closeContextMenu() { this.overlay.closeContextMenu(); }
  openPluginPanel(pluginId) { this.overlay.openPluginPanel(pluginId); }
  closePluginPanel() { this.overlay.closePluginPanel(); }

  setActivity(activity) {
    this.#set({ activity, sidebarVisible: true });
    this.context.set('view.active', activity);
  }
  /** Return to the launcher home (reset the panel stack to the base search). */
  showHome() {
    this.#set({ activity: 'home' });
    this.#applyStack([{ kind: 'search' }]);
    this.context.set('view.active', 'home');
  }
  toggleSidebar(force) {
    const v = force ?? !this.state.sidebarVisible;
    this.#set({ sidebarVisible: v });
    this.context.set('sidebar.visible', v);
  }

  // --- launcher --------------------------------------------------------------
  setLaunchQuery(query) {
    this.#set({ launch: { query, index: 0 } });
  }
  moveLaunch(delta, count) {
    if (!count) return;
    this.#set({ launch: { ...this.state.launch, index: wrapIndex(this.state.launch.index, delta, count) } });
  }
  setLaunchIndex(index) {
    this.#set({ launch: { ...this.state.launch, index } });
  }

  // --- modal search (double-shift) ------------------------------------------
  openSearchModal() {
    this.#set({ searchModal: true, launch: { query: '', index: 0 } });
    this.context.set('searchModal.open', true);
  }
  closeSearchModal() {
    this.#set({ searchModal: false });
    this.context.set('searchModal.open', false);
  }

  // --- panel stack -----------------------------------------------------------
  #top() {
    return this.state.stack[this.state.stack.length - 1];
  }
  /** The active file panel (top of the stack, if it's a file). */
  activeTab() {
    const t = this.#top();
    return t && t.kind === 'file' ? t : null;
  }

  #applyStack(stack, { history = true } = {}) {
    const top = stack[stack.length - 1];
    const file = top && top.kind === 'file' ? top : null;
    this.#set({ stack, activeTabId: file ? file.id : null, activeFile: file ? file.node : null, searchModal: false });
    this.context.setMany({ 'editor.open': !!file, 'editor.openerId': file?.openerId || '', 'editor.contentType': file?.node.contentType || '' });
    if (history) this.#pushHistory();
  }

  /**
   * Open a file into the viewer stack. `reset` (used by the modal search) starts a
   * fresh stack (base search + this file). Opening a file already in the stack
   * jumps back to it; otherwise it's pushed on top.
   */
  openFile(node, openerId, { reset = false } = {}) {
    const panel = { kind: 'file', id: node.id, node, openerId };
    let stack;
    if (reset) {
      stack = [{ kind: 'search' }, panel];
    } else {
      const at = this.state.stack.findIndex((p) => p.kind === 'file' && p.id === node.id);
      if (at >= 0) {
        // Already open — jump back to it, but adopt the (possibly new) opener so
        // reopening with a different one actually switches the viewer.
        stack = this.state.stack.slice(0, at + 1);
        stack[at] = panel;
      } else {
        stack = [...this.state.stack, panel];
      }
    }
    this.#set({ activity: 'home' });
    this.#pushRecent(node);
    this.#applyStack(stack);
  }
  // Back-compat alias (OpenFileAction historically called openTab).
  openTab(node, openerId) {
    this.openFile(node, openerId);
  }
  back() {
    if (this.state.stack.length <= 1) return;
    try { history.back(); } catch { this.pop(); }
  }
  pop() {
    if (this.state.stack.length > 1) this.#applyStack(this.state.stack.slice(0, -1), { history: false });
  }
  closeTab(id) {
    const stack = this.state.stack.filter((p) => !(p.kind === 'file' && p.id === id));
    this.#applyStack(stack.length ? stack : [{ kind: 'search' }], { history: false });
  }
  updateTabNode(node) {
    const stack = this.state.stack.map((p) => (p.kind === 'file' && p.id === node.id ? { ...p, node } : p));
    this.#applyStack(stack, { history: false });
  }

  // --- history sync ----------------------------------------------------------
  #pushHistory(replace = false) {
    const top = this.#top();
    const n = top?.node;
    const entry = {
      troveDepth: this.state.stack.length,
      node: n ? { id: n.id, name: n.name, contentType: n.contentType, path: n.path, kind: 'file' } : null,
      openerId: top?.openerId || null,
    };
    try { (replace ? history.replaceState : history.pushState).call(history, entry, ''); } catch { /* no history API */ }
  }
  /** Handle a browser back/forward: sync the stack depth (re-open on forward). */
  onPopState(e) {
    const s = e?.state || {};
    const depth = s.troveDepth || 1;
    if (depth <= this.state.stack.length) {
      this.#applyStack(this.state.stack.slice(0, depth), { history: false });
    } else if (s.node) {
      this.#applyStack([...this.state.stack, { kind: 'file', id: s.node.id, node: s.node, openerId: s.openerId }], { history: false });
    }
  }

  #pushRecent(node) {
    if (!node || node.kind === 'folder') return;
    const entry = { id: node.id, name: node.name, contentType: node.contentType || '', path: node.path, kind: 'file' };
    const recents = [entry, ...this.state.recents.filter((r) => r.id !== node.id)].slice(0, RECENTS_MAX);
    this.#set({ recents });
    saveRecents(recents);
  }

  toggleInfoPanel(force) {
    this.#set({ infoPanel: force ?? !this.state.infoPanel });
    this.context.set('infoPanel.open', this.state.infoPanel);
  }

  /** Close any transient overlay (Esc), in priority order across overlay + stack.
   *  Returns true if something closed. */
  closeOverlays() {
    const o = this.overlay.state;
    if (o.contextMenu) return this.overlay.closeContextMenu(), true;
    if (o.dialog) return this.overlay.closeDialog(), true;
    if (this.state.searchModal) return this.closeSearchModal(), true;
    if (o.palette) return this.overlay.closePalette(), true;
    if (o.pluginPanel) return this.overlay.closePluginPanel(), true;
    if (this.state.stack.length > 1) return this.back(), true; // pop the top viewer panel
    return false;
  }
}

function loadRecents() {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY)) || []; } catch { return []; }
}
function saveRecents(recents) {
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(recents)); } catch { /* private mode / no storage */ }
}
