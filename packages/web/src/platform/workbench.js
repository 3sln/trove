// WorkbenchService — the shell's ephemeral UI state (not the file data, which
// ngin owns). The main panel is a STACK of panels: the base is the root search
// (launcher); opening a file pushes a viewer panel; back pops. The stack is mirrored
// into the browser history (pushState/popState) so back/forward navigate it. A
// double-shift opens a modal search overlay; picking from it resets the stack.
// It also mirrors key bits into the ContextKeyService for when-clauses.

import { ObservableSubject } from '../runtime.js';

const RECENTS_KEY = 'trove.recents';
const RECENTS_MAX = 12;

export class WorkbenchService {
  constructor(context) {
    this.context = context;
    this.state = {
      activity: 'home', // home (stack) | plugins | settings
      sidebarVisible: true,
      palette: null, // { mode: 'commands'|'files', query } when open
      launch: { query: '', index: 0 }, // the launcher's query
      searchModal: false, // the double-shift modal search overlay
      stack: [{ kind: 'search' }], // [{kind:'search'}, {kind:'file', id, node, openerId}, …]
      activeTabId: null, // top file panel id (or null)
      activeFile: null, // top file panel node (or null)
      recents: loadRecents(),
      pluginPanel: null,
      dialog: null,
      contextMenu: null,
      infoPanel: false,
    };
    this.subject = new ObservableSubject(this.state);
  }

  observe() {
    return this.subject;
  }
  #set(patch) {
    this.state = { ...this.state, ...patch };
    this.subject.next(this.state);
  }

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

  openPalette(mode = 'commands', query = '') {
    this.#set({ palette: { mode, query, index: 0 } });
    this.context.set('palette.open', true);
  }
  setPaletteQuery(query) {
    if (this.state.palette) this.#set({ palette: { ...this.state.palette, query, index: 0 } });
  }
  movePalette(delta, count) {
    if (!this.state.palette || !count) return;
    const index = (this.state.palette.index + delta + count) % count;
    this.#set({ palette: { ...this.state.palette, index } });
  }
  setPaletteIndex(index) {
    if (this.state.palette) this.#set({ palette: { ...this.state.palette, index } });
  }
  closePalette() {
    this.#set({ palette: null });
    this.context.set('palette.open', false);
  }

  // --- launcher --------------------------------------------------------------
  setLaunchQuery(query) {
    this.#set({ launch: { query, index: 0 } });
  }
  moveLaunch(delta, count) {
    if (!count) return;
    const index = (this.state.launch.index + delta + count) % count;
    this.#set({ launch: { ...this.state.launch, index } });
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
      stack = at >= 0 ? this.state.stack.slice(0, at + 1) : [...this.state.stack, panel];
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
  openPluginPanel(pluginId) {
    this.#set({ pluginPanel: pluginId });
  }
  closePluginPanel() {
    this.#set({ pluginPanel: null });
  }

  showContextMenu(x, y, items) {
    this.#set({ contextMenu: { x, y, items } });
  }
  closeContextMenu() {
    this.#set({ contextMenu: null });
  }
  showDialog(dialog) {
    this.#set({ dialog });
  }
  closeDialog() {
    this.#set({ dialog: null });
  }

  /** Close any transient overlay (Esc). Returns true if something closed. */
  closeOverlays() {
    if (this.state.contextMenu) return this.closeContextMenu(), true;
    if (this.state.dialog) return this.closeDialog(), true;
    if (this.state.searchModal) return this.closeSearchModal(), true;
    if (this.state.palette) return this.closePalette(), true;
    if (this.state.pluginPanel) return this.closePluginPanel(), true;
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
