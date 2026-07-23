// WorkbenchService — the shell's ephemeral UI state (not the file data, which
// ngin owns). Which activity is open, is the sidebar/palette/panel showing, the
// list of open editor tabs and the active one, any modal (context menu, dialog).
// It's reactive and also mirrors key bits into the ContextKeyService so
// when-clauses (and thus keybindings/menus) react to it.

import { ObservableSubject } from '../runtime.js';

export class WorkbenchService {
  constructor(context) {
    this.context = context;
    this.state = {
      activity: 'explorer', // explorer | search | plugins | settings
      sidebarVisible: true,
      palette: null, // { mode: 'commands'|'files', query } when open
      tabs: [], // [{ id, node, openerId }]
      activeTabId: null,
      pluginPanel: null, // pluginId when a plugin popup is open
      dialog: null, // { kind, ... } modal dialog
      contextMenu: null, // { x, y, items }
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

  openTab(node, openerId) {
    const existing = this.state.tabs.find((t) => t.id === node.id);
    const tabs = existing ? this.state.tabs : [...this.state.tabs, { id: node.id, node, openerId }];
    this.#set({ tabs, activeTabId: node.id, activity: this.state.activity });
    this.context.setMany({ 'editor.open': true, 'editor.openerId': openerId, 'editor.contentType': node.contentType || '' });
  }
  activateTab(id) {
    const t = this.state.tabs.find((x) => x.id === id);
    if (!t) return;
    this.#set({ activeTabId: id });
    this.context.setMany({ 'editor.open': true, 'editor.openerId': t.openerId, 'editor.contentType': t.node.contentType || '' });
  }
  closeTab(id) {
    const tabs = this.state.tabs.filter((t) => t.id !== id);
    let activeTabId = this.state.activeTabId;
    if (activeTabId === id) activeTabId = tabs.length ? tabs[tabs.length - 1].id : null;
    this.#set({ tabs, activeTabId });
    this.context.set('editor.open', tabs.length > 0);
  }
  activeTab() {
    return this.state.tabs.find((t) => t.id === this.state.activeTabId) || null;
  }
  updateTabNode(node) {
    const tabs = this.state.tabs.map((t) => (t.id === node.id ? { ...t, node } : t));
    this.#set({ tabs });
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
    if (this.state.palette) return this.closePalette(), true;
    if (this.state.pluginPanel) return this.closePluginPanel(), true;
    return false;
  }
}
