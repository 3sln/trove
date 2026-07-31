// NavigationService — the main panel STACK and its browser-history mirror. The base
// of the stack is the launcher (search); opening a file pushes a viewer panel; back
// pops. The stack is mirrored into window.history (pushState/popState) so the browser
// back/forward buttons navigate it. Also owns the "recent files" list. Extracted from
// WorkbenchService; the workbench coordinates the couplings it can't own (setting the
// activity to 'home' and closing the modal search when a file opens).

import { cell } from '../runtime.js';

const RECENTS_KEY = 'trove.recents';
const RECENTS_MAX = 12;

export class NavigationService {
  constructor() {
    this.state = {
      stack: [{ kind: 'search' }], // [{kind:'search'}, {kind:'file', id, node, openerId}, …]
      activeTabId: null, // top file panel id (or null)
      activeFile: null, // top file panel node (or null)
      recents: loadRecents(),
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

  #top() {
    return this.state.stack[this.state.stack.length - 1];
  }
  /** The active file panel (top of the stack, if it's a file). */
  activeTab() {
    const t = this.#top();
    return t?.kind === 'file' ? t : null; // panel kind, not node kind
  }

  #applyStack(stack, { history = true } = {}) {
    const top = stack[stack.length - 1];
    const file = top && top.kind === 'file' ? top : null;
    this.#set({ stack, activeTabId: file ? file.id : null, activeFile: file ? file.node : null });
    if (history) this.#pushHistory();
  }

  /** Reset to the base launcher (used by showHome). */
  reset() {
    this.#applyStack([{ kind: 'search' }]);
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
    this.#pushRecent(node);
    this.#applyStack(stack);
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
      node: n ? { id: n.id, name: n.name, contentType: n.contentType, collectionId: n.collectionId } : null,
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
    if (!node) return;
    const entry = { id: node.id, name: node.name, contentType: node.contentType || '', collectionId: node.collectionId };
    const recents = [entry, ...this.state.recents.filter((r) => r.id !== node.id)].slice(0, RECENTS_MAX);
    this.#set({ recents });
    saveRecents(recents);
  }
}

function loadRecents() {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY)) || []; } catch { return []; }
}
function saveRecents(recents) {
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(recents)); } catch { /* private mode / no storage */ }
}
