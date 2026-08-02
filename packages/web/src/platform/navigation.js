// NavigationService — the main panel STACK and its browser-history mirror. The base
// of the stack is the launcher (search); opening a file pushes a viewer panel; back
// pops. The stack is mirrored into window.history (pushState/popState) so the browser
// back/forward buttons navigate it. Also owns the "recent files" list. Extracted from
// WorkbenchService; the workbench coordinates the couplings it can't own (setting the
// activity to 'home' and closing the modal search when a file opens).

import { cell } from '../runtime.js';
import { thumbnailOf } from '../bl/fileType.js';

const RECENTS_KEY = 'trove.recents';
const RECENTS_MAX = 12;

export class NavigationService {
  #state;

  constructor() {
    this.#state = {
      stack: [{ kind: 'search' }], // [{kind:'search'}, {kind:'file', id, node, openerId}, …]
      activeTabId: null, // top file panel id (or null)
      activeFile: null, // top file panel node (or null)
      recents: loadRecents(),
    };
    this.cell = cell(this.#state);
  }

  /**
   * The value, for whoever is about to decide something from it.
   *
   * The same door every slice offers. Actions read `.state` and queries read `.cell`, and
   * the two are only equal by habit — bl/state.js says so, and says a resource has one
   * value and one way to read it. `state` is also a public field on a service, which is one
   * typo from `social.state.sidecar = null` bypassing the cell and notifying nothing.
   */
  get() {
    return this.#state;
  }

  observe() {
    return this.cell;
  }
  #set(patch) {
    this.#state = { ...this.#state, ...patch };
    this.cell.setValue(this.#state);
  }

  #top() {
    return this.#state.stack[this.#state.stack.length - 1];
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
      const at = this.#state.stack.findIndex((p) => p.kind === 'file' && p.id === node.id);
      if (at >= 0) {
        // Already open — jump back to it, but adopt the (possibly new) opener so
        // reopening with a different one actually switches the viewer.
        stack = this.#state.stack.slice(0, at + 1);
        stack[at] = panel;
      } else {
        stack = [...this.#state.stack, panel];
      }
    }
    this.#pushRecent(node);
    this.#applyStack(stack);
  }
  back() {
    if (this.#state.stack.length <= 1) return;
    try { history.back(); } catch { this.pop(); }
  }
  pop() {
    if (this.#state.stack.length > 1) this.#applyStack(this.#state.stack.slice(0, -1), { history: false });
  }
  /**
   * The node is GONE — drop it from everywhere this service holds a copy.
   *
   * Named for what happened rather than for the stack, because it was `closeTab` and so
   * only closed the panel: a deleted file kept its recent tile, and clicking that tile
   * opened nothing. Recents are a snapshot, not a reference, so nothing else was ever
   * going to notice.
   *
   * Trashing is reversible and this is not, quite: restoring a file does not put it back
   * in recents, it just stops being listed until opened again. That is the right way
   * round — a tile that leads nowhere is worse than one that is missing.
   */
  forget(id) {
    const recents = this.#state.recents.filter((r) => r.id !== id);
    if (recents.length !== this.#state.recents.length) {
      this.#set({ recents });
      saveRecents(recents);
    }
    const stack = this.#state.stack.filter((p) => !(p.kind === 'file' && p.id === id));
    this.#applyStack(stack.length ? stack : [{ kind: 'search' }], { history: false });
  }
  /**
   * A node changed underneath us — a rename — so every copy of it here has to change.
   *
   * BOTH the stack and the recents list, because recents hold a SNAPSHOT (id, name,
   * contentType) rather than a reference: updating only the stack renamed the open panel's
   * title and left the recent tile showing the old name until it aged off the end of the
   * list, which reads as the rename half-failing.
   */
  updateTabNode(node) {
    const recents = this.#state.recents.map((r) => (r.id === node.id
      ? { ...r, name: node.name, contentType: node.contentType || r.contentType, ...(thumbnailOf(node) ? { thumbnail: thumbnailOf(node) } : {}) }
      : r));
    if (recents.some((r, i) => r !== this.#state.recents[i])) {
      this.#set({ recents });
      saveRecents(recents);
    }
    const stack = this.#state.stack.map((p) => (p.kind === 'file' && p.id === node.id ? { ...p, node } : p));
    this.#applyStack(stack, { history: false });
  }

  // --- history sync ----------------------------------------------------------
  #pushHistory(replace = false) {
    const top = this.#top();
    const n = top?.node;
    const entry = {
      troveDepth: this.#state.stack.length,
      node: n ? { id: n.id, name: n.name, contentType: n.contentType, collectionId: n.collectionId } : null,
      openerId: top?.openerId || null,
    };
    try { (replace ? history.replaceState : history.pushState).call(history, entry, ''); } catch { /* no history API */ }
  }
  /** Handle a browser back/forward: sync the stack depth (re-open on forward). */
  onPopState(e) {
    const s = e?.state || {};
    const depth = s.troveDepth || 1;
    if (depth <= this.#state.stack.length) {
      this.#applyStack(this.#state.stack.slice(0, depth), { history: false });
    } else if (s.node) {
      this.#applyStack([...this.#state.stack, { kind: 'file', id: s.node.id, node: s.node, openerId: s.openerId }], { history: false });
    }
  }

  #pushRecent(node) {
    if (!node) return;
    // The THUMBNAIL rides along, and it has to, because a recent entry is a snapshot
    // rather than a reference: nothing later re-reads the node, so a tile drawn from
    // this object sees whatever is stored here and nothing else. Without it a recently
    // opened book showed a generic icon while the very same file two rows below showed
    // its cover — the one difference being which group drew it.
    //
    // Only the descriptor, not the image. It is a range into the file (~80 bytes), so a
    // dozen of them is under a kilobyte of localStorage; storing the whole contribution
    // would put four kilobytes per book in there for no gain.
    const thumbnail = thumbnailOf(node);
    const entry = {
      id: node.id, name: node.name, contentType: node.contentType || '', collectionId: node.collectionId,
      ...(thumbnail ? { thumbnail } : {}),
    };
    const recents = [entry, ...this.#state.recents.filter((r) => r.id !== node.id)].slice(0, RECENTS_MAX);
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
