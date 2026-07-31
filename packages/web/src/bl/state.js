// The drive's own state, as named slices.
//
// These were classes: an `ExplorerService`, a `SearchClientService`, an `ApiKeysService`,
// each holding a `state` field, a `cell`, and a `set` that wrote both. Nothing else. A
// service should cover something complex and offer it through a narrow door — these
// covered an object.
//
// Two things came of that shape and both are gone with it.
//
// TWO DOORS. Actions read `.state` and queries read `.cell`, and the two are only equal by
// habit: most services wrote `this.state = {...}; this.cell.setValue(this.state)`, but not
// all did, and `settings` still has a cell holding `effective()` and no `state` field at
// all. A slice has one value and one way to read it.
//
// LOGIC IN THE HOLDER. `toggleCap` computed a capability set inside the service while an
// action stood in front of it forwarding two arguments — and dropped one of them, which is
// how a minted key came to be rejected by the server. Arithmetic over state belongs to the
// action that decides to change it; the slice only holds.
//
// Each slice is still its OWN provider, so `static deps = ['explorer']` keeps meaning what
// it says. A single `appState` covering everything would put the whole drive back behind
// one lease, which is what naming the resources individually was for.

import { cell } from '../runtime.js';

/**
 * One named piece of the drive's state.
 *
 * `set` merges, because every caller was already merging and doing it here removes the
 * chance of a caller replacing a slice by forgetting to spread it. `replace` exists for
 * the cases that genuinely mean "all of it" — a fresh panel stack, an emptied list.
 *
 * @param {object} initial
 */
export function slice(initial = {}) {
  const held = cell(initial);
  return {
    /** The cell, for a query to watch. */
    observe: () => held,
    /** The value, for an action about to decide something from it. */
    get: () => held.getValue(),
    /** Merge a patch in. A new object every time — a cell compares with Object.is. */
    set: (patch) => held.setValue({ ...held.getValue(), ...patch }),
    /** Replace it outright, for when a patch would be a lie. */
    replace: (next) => held.setValue(next),
  };
}

/** Items, selection, the open collection, and the gate. */
export const explorerState = (settings) => slice({
  items: [], loading: false, error: null,
  selection: [], sort: settings.get('explorer.sort'), order: settings.get('explorer.sortOrder'),
  // No collection until one is chosen or created. `gate` is 'create' | 'choose' | null —
  // when set, it is the ONLY thing the workbench shows, because every request needs a
  // collection and there is nothing sensible to render without one.
  collectionId: null, collections: [], canCreateCollection: false, gate: null,
  // `stats` is the whole collection; `items` is the page on screen. Keeping both is what
  // lets the UI say "500 of 3,006" instead of quietly claiming 500.
  stats: null, usage: null, nextCursor: null, loadingMore: false, trash: null,
});

/** Query text, results, and the palette's separate file list. */
export const searchState = () => slice({
  query: '', mode: 'hybrid', results: [], loading: false, error: null, ran: false,
  paletteFiles: [], paletteQuery: '', paletteLoading: false, paletteError: null,
});

/**
 * The admin API-key list.
 *
 * `minted` holds the one secret a mint returns. It lives here, in memory, and is dropped
 * the moment the admin dismisses it — the server cannot show it again, so the UI is the
 * only place it ever exists and it must not outlive the tab.
 *
 * `draft` is the mint form. Held in state rather than in the DOM so the section stays a
 * pure function of state, and so a half-filled form survives a re-render caused by
 * something else on the settings screen.
 */
export const apiKeysState = () => slice({
  keys: [], loading: false, loaded: false, error: null, minted: null, busy: null, draft: null,
});

/**
 * What the UI is in the middle of doing — a keybinding mid-capture, text typed into a
 * dialog that has not been submitted, the boxes ticked in a plugin review.
 *
 * None of it is drive state; all of it decides what is on screen, which is what makes it
 * engine state. Keyed by component, so `set` here replaces one key rather than merging a
 * patch — see SetViewStateAction.
 */
export const viewState = () => slice({});
