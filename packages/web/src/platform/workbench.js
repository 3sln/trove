// WorkbenchService — the shell's ephemeral UI state (not the file data, which
// ngin owns). The main panel is a STACK of panels: the base is the root search
// (launcher); opening a file pushes a viewer panel; back pops. The stack is mirrored
// into the browser history (pushState/popState) so back/forward navigate it. A
// double-shift opens a modal search overlay; picking from it resets the stack.
// It also mirrors key bits into the ContextKeyService for when-clauses.

import { ObservableSubject } from '../runtime.js';
import { OverlayService, wrapIndex } from './overlay.js';
import { NavigationService } from './navigation.js';

export class WorkbenchService {
  constructor(context) {
    this.context = context;
    // Two focused sub-services own their own state + subject; the workbench delegates
    // and coordinates the couplings across them (Esc close-order, opening a file).
    this.overlay = new OverlayService(context);
    this.nav = new NavigationService(context);
    this.state = {
      activity: 'home', // home (stack) | plugins | settings
      sidebarVisible: true,
      launch: { query: '', index: 0 }, // the launcher's query
      searchModal: false, // the double-shift modal search overlay
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
  observeNav() {
    return this.nav.observe();
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

  // --- navigation delegations (state lives in NavigationService) -------------
  activeTab() { return this.nav.activeTab(); }
  back() { this.nav.back(); }
  pop() { this.nav.pop(); }
  closeTab(id) { this.nav.closeTab(id); }
  updateTabNode(node) { this.nav.updateTabNode(node); }
  onPopState(e) { this.nav.onPopState(e); }

  setActivity(activity) {
    this.#set({ activity, sidebarVisible: true });
    this.context.set('view.active', activity);
  }
  /** Return to the launcher home (reset the panel stack to the base search). */
  showHome() {
    this.#set({ activity: 'home', searchModal: false });
    this.nav.reset();
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

  /**
   * Open a file into the viewer stack (delegates to NavigationService). Coordinates the
   * shell state the nav service can't own: switch to the home activity and close the
   * modal search overlay.
   */
  openFile(node, openerId, opts = {}) {
    this.#set({ activity: 'home', searchModal: false });
    this.nav.openFile(node, openerId, opts);
  }
  // Back-compat alias (OpenFileAction historically called openTab).
  openTab(node, openerId) {
    this.openFile(node, openerId);
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
    if (this.nav.state.stack.length > 1) return this.nav.back(), true; // pop the top viewer panel
    return false;
  }
}
