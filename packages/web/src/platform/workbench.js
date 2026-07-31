// WorkbenchService — the shell's ephemeral UI state (not the file data, which
// ngin owns). The main panel is a STACK of panels: the base is the root search
// (launcher); opening a file pushes a viewer panel; back pops. The stack is mirrored
// into the browser history (pushState/popState) so back/forward navigate it. A
// double-shift opens a modal search overlay; picking from it resets the stack.
//
// It holds state and nothing else. The when-clause keys it used to mirror into the context
// service are derived from these cells now — see bl/context.js.

import { cell } from '../runtime.js';
import { OverlayService, wrapIndex } from './overlay.js';
import { NavigationService } from './navigation.js';

export class WorkbenchService {
  constructor() {
    // Two focused sub-services own their own state + subject; the workbench delegates
    // and coordinates the couplings across them (Esc close-order, opening a file).
    //
    // None of the three writes context keys any more. Those are DERIVED from these cells —
    // see bl/context.js — so opening a sheet cannot forget to say that a sheet is open.
    this.overlay = new OverlayService();
    this.nav = new NavigationService();
    this.state = {
      activity: 'home', // home (stack) | plugins | settings
      sidebarVisible: true,
      launch: { query: '', index: 0 }, // the launcher's query
      searchModal: false, // the double-shift modal search overlay
      infoPanel: false,
      // Phone chrome: which bottom sheet is up, if any ('status' | 'more'). A phone has
      // no room for a permanent status bar or a left rail, so both fold into a sheet
      // that is pulled up on demand.
      sheet: null,
    };
    this.cell = cell(this.state);
  }

  observe() {
    return this.cell;
  }
  observeOverlay() {
    return this.overlay.observe();
  }
  observeNav() {
    return this.nav.observe();
  }
  #set(patch) {
    this.state = { ...this.state, ...patch };
    this.cell.setValue(this.state);
  }

  // --- overlay delegations (state lives in OverlayService) -------------------
  openPalette(mode, query) { this.overlay.openPalette(mode, query); }
  setPaletteQuery(query) { this.overlay.setPaletteQuery(query); }
  movePalette(delta, count) { this.overlay.movePalette(delta, count); }
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
  }
  /** Return to the launcher home (reset the panel stack to the base search). */
  showHome() {
    this.#set({ activity: 'home', searchModal: false });
    this.nav.reset();
  }

  // --- launcher --------------------------------------------------------------
  setLaunchQuery(query) {
    this.#set({ launch: { query, index: 0 } });
  }
  moveLaunch(delta, count) {
    if (!count) return;
    this.#set({ launch: { ...this.state.launch, index: wrapIndex(this.state.launch.index, delta, count) } });
  }
  /** The command palette's highlighted row. Missing entirely, so every `mouseenter`
   *  threw and the highlight never followed the pointer — hover row 5, press Enter,
   *  run row 0. */
  setPaletteIndex(index) {
    this.overlay.setPaletteIndex?.(index);
  }
  setLaunchIndex(index) {
    this.#set({ launch: { ...this.state.launch, index } });
  }

  // --- modal search (double-shift) ------------------------------------------
  openSearchModal() {
    this.#set({ searchModal: true, launch: { query: '', index: 0 } });
  }
  closeSearchModal() {
    this.#set({ searchModal: false });
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
  /** Raise (or swap, or drop) the phone bottom sheet. Tapping the open one closes it. */
  openSheet(name) {
    this.#set({ sheet: this.state.sheet === name ? null : name });
  }
  closeSheet() {
    if (!this.state.sheet) return;
    this.#set({ sheet: null });
  }
  toggleInfoPanel(force) {
    this.#set({ infoPanel: force ?? !this.state.infoPanel });
  }

  /** Close any transient overlay (Esc), in priority order across overlay + stack.
   *  Returns true if something closed. */
  closeOverlays() {
    const o = this.overlay.state;
    if (o.contextMenu) return this.overlay.closeContextMenu(), true;
    if (o.dialog) return this.overlay.closeDialog(), true;
    if (this.state.sheet) return this.closeSheet(), true;
    if (this.state.searchModal) return this.closeSearchModal(), true;
    if (o.palette) return this.overlay.closePalette(), true;
    if (o.pluginPanel) return this.overlay.closePluginPanel(), true;
    if (this.nav.state.stack.length > 1) return this.nav.back(), true; // pop the top viewer panel
    return false;
  }
}
