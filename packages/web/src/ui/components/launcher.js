// The main-panel launcher — search-first "home" that replaces the explorer
// sidebar. Empty query shows recents + everything in the collection; typing
// searches files; a leading `!` switches to command execution; a leading `#`
// filters by tag/property (parsed in the search layer). One keyboard-navigable
// list across whichever mode is active.

import { dd } from '../../runtime.js';
import { icon } from '../icon.js';
import { ExecCommandAction, FilterAction, MoveLaunchAction, SearchAction, SelectLaunchAction, SetLaunchIndexAction, SetLaunchQueryAction } from '../../bl/actions.js';
import { parseTagQuery, filterLabel } from '../../bl/tagQuery.js';
import { renderView, viewSwitcher, viewMove } from './views/index.js';
import { openRowMenu } from './views/parts.js';
import { activate } from '../activate.js';

const { div, span, input, button } = dd;

// The keys a view may claim. Everything else the search box keeps.
const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

// What to put in the search box, and how much of it fits.
//
// The server tells us, because the search TRANSFORMER decides what the box accepts and
// that is deployment configuration — swap in an LLM transformer and "# filter by tag"
// stops being the right advice. The fallback covers the moment before capabilities
// arrive and any server too old to say; `!` is ours either way, since running a command
// from here is a client convention the server knows nothing about.
function promptFor(caps, { compact = false, modal = false } = {}) {
  const p = caps?.searchPrompt;
  const base = (compact ? p?.short || p?.placeholder : p?.placeholder)
    || (compact ? 'Search files' : 'Search files · # filter by tag');
  // On a phone the box is ~300px wide; adding a second clause guarantees an ellipsis
  // in the middle of the instructions, which reads as broken rather than terse.
  return compact || modal ? base : `${base} · ! run a command`;
}

// Debounce timers, one PER SURFACE. workbench.js mounts the home launcher and the modal
// one together, and a single module slot meant typing in the modal cancelled the home
// box's pending search — one keystroke in one component silently discarding another's.
// A timer is not application state (the engine has no use for a pending timeout), but it
// does belong to the surface that armed it.
const timers = new Map();
const arm = (key, fn, ms) => {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(fn, ms));
};

function runSearch(ui, key, query) {
  // SearchAction owns search state; the launcher only dispatches (no direct .set).
  arm(key, () => ui.engine.dispatch(new SearchAction(query)), 240);
}
function clearSearch(ui, key) {
  // The pending timer FIRST. Typing then pressing Escape inside 240ms let the search for
  // what was typed land after the clear — the results list stayed put (it reads the launch
  // query) while the resolved bar said "Searching …" over the home list, and `pickView`
  // could switch the view under it. SearchAction now also refuses a superseded answer, so
  // this is belt and braces on a race that produced a visibly wrong screen.
  clearTimeout(timers.get(key));
  ui.engine.dispatch(new SetLaunchQueryAction(''));
  ui.engine.dispatch(new SearchAction('')); // empty query resets results/ran/error
}
function runFilter(ui, key, filters, text) {
  arm(key, () => ui.engine.dispatch(new FilterAction(filters, text)), 200);
}

export default function launcher(state, ui, opts = {}) {
  const modal = !!opts.modal; // rendered as the double-shift overlay → picks reset the stack
  const q = state.wb.launch.query;
  // What is on screen, which view draws it, and whether a search-help offer applies — all
  // decided by the `launcherContent` query. This used to be ~100 lines of derivation right
  // here: which nodes, what each heading says, whether "All items" is a claim the drive
  // cannot support. See bl/launcher.js.
  const content = modal ? state.modalContent : state.content;
  const { groups, mode, view } = content;
  const flat = groups.flatMap((g) => g.items);
  const idx = flat.length ? Math.min(state.wb.launch.index, flat.length - 1) : 0;

  // Which surface this is, so the two launchers do not share one debounce slot.
  const timerKey = modal ? 'modal' : 'home';
  const onInput = (e) => {
    const v = e.target.value;
    ui.engine.dispatch(new SetLaunchQueryAction(v));
    if (v.startsWith('!')) return; // command mode: no query dispatch
    const { text, filters } = parseTagQuery(v);
    if (filters.length) runFilter(ui, timerKey, filters, text); // drive-wide tag/property query
    else runSearch(ui, timerKey, text);
  };
  // Moving the highlight with the KEYBOARD is selecting, as far as the rest of the app
  // is concerned. Without this, `explorer.selectedNodes()` was permanently empty and
  // every command that works on "the selected item" — delete above all — silently did
  // nothing.
  //
  // Hovering deliberately does not select. It moves the highlight (so Enter opens what
  // the pointer is over) but leaves the selection alone: a second state push per mouse
  // move re-renders the list under the pointer, and a row replaced between mousedown and
  // mouseup never receives its click. A pointer user acts through the row's own menu,
  // which selects explicitly before it opens.
  const hoverAt = (at) => ui.engine.dispatch(new SetLaunchIndexAction(at));
  // Moving the highlight and selecting what it lands on are one action, not two. The index
  // wraps, so only the store can say where a move ends up — and reading that back out here
  // would read it before the dispatch had applied. See MoveLaunchAction.
  const selectAt = (at) => ui.engine.dispatch(new SelectLaunchAction(at, flat[at]?.node));
  const move = (delta) => ui.engine.dispatch(new MoveLaunchAction(delta, flat.map((i) => i.node)));
  // The view gets a say in what an arrow key means — one row down is one tile down in a
  // grid, not one tile across — but the index, the selection and the wrapping stay here, so
  // up and down mean the same thing whichever view is showing.
  const onKey = (e) => {
    // `textual`: there is text in the box, so left/right are the caret's and no view
    // may claim them. Fixing a typo must not move the highlight.
    const claimed = ARROWS.has(e.key)
      ? viewMove(view, e.key, { index: idx, count: flat.length, textual: q.length > 0 })
      : null;
    if (claimed !== null) { e.preventDefault(); move(claimed); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); activate(ui, flat[idx]); }
    else if (e.key === 'Escape' && q) { e.preventDefault(); clearSearch(ui, timerKey); }
    // The row under the highlight is the subject of the row menu, so the key that opens
    // one on every other list opens this one too — without making the user leave the
    // search box to reach it.
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const it = flat[idx];
      // Arrowing here already selected the row, so the menu acts on the right thing.
      if (it?.menu) { e.preventDefault(); openRowMenu(document.querySelector('.launch-item.active, .grid-tile.active'), it, ui); }
    }
  };

  // What the server actually searched (transformer output) — shown when it differs
  // from what the user typed, so an LLM-assisted transform stays honest.
  const resolved = mode === 'search' ? state.se.resolved : null;
  const showResolved = resolved && (resolved.source === 'llm'
    || (resolved.tagFilters && resolved.tagFilters.length)
    || (resolved.semanticText || '').trim() !== q.trim());

  const inner = div({ className: 'launcher' },
    div({ className: 'launch-box' },
      icon(mode === 'command' ? 'command' : mode === 'filter' ? 'tag' : 'search', { size: 18 }),
      // `false`, not `'false'`: this is set as a property, and the string is truthy —
      // so the search box had spellcheck ON, red-underlining every filename typed into it.
      input({ className: 'launch-input', value: q, autofocus: true, spellcheck: false,
        placeholder: promptFor(state.caps, { compact: state.vp?.mode === 'phone', modal }) })
        .on({ input: onInput, keydown: onKey }),
      q ? button({ className: 'launch-clear', title: 'Clear' }, icon('close', { size: 14 }))
        .on({ click: () => clearSearch(ui, timerKey) }) : null,
      // Only where the browser can transcribe WITHOUT sending audio anywhere. A remote's
      // own mic needs no button from us — it dictates into this field once it is focused,
      // which is what `search.voice` is really for.
      state.voice?.canListen
        ? button({
          className: `launch-mic ${state.voice?.listening ? 'on' : ''}`,
          title: state.voice?.listening ? 'Stop listening' : 'Search by voice',
          'aria-pressed': state.voice?.listening ? 'true' : 'false',
        }, icon('mic', { size: 15 })).on({ click: () => ui.engine.dispatch(new ExecCommandAction('search.voice')) })
        : null,
      // Which way to look at the drive. Not in the modal search, where the answer is
      // always "the one thing I am about to press Enter on".
      modal ? null : viewSwitcher(state.views, view, ui),
    ),
    showResolved ? resolvedBar(resolved) : null,
    // The results belong to the active view — see ui/components/views. The launcher says
    // WHAT is on screen (these groups, this highlight); the view says how it looks. That
    // split is why a gallery is a contribution rather than another branch in here.
    div({ className: 'launch-body' },
      renderView(view, { groups, index: idx, handlers: { hover: hoverAt, select: selectAt }, state, ui }),
      searchHelp(content.help, ui),
    ),
  );
  return modal ? inner : div({ className: 'editor' }, inner);
}

// An "under-bar" reflecting what the search actually ran (the transformer's output):
// the semantic text it searched for + any tag filters it applied. Read-only and
// honest — we don't rewrite the user's input, we just show what was dispatched.
function resolvedBar(r) {
  return div({ className: 'launch-resolved' },
    span({ className: 'rq-label' }, r.source === 'llm' ? 'Interpreted as' : 'Searching'),
    (r.semanticText || '').trim() ? span({ className: 'rq-text' }, `“${r.semanticText.trim()}”`) : null,
    ...(r.tagFilters || []).map((f) => span({ className: 'rq-chip' }, icon('tag', { size: 11 }), filterLabel(f))),
  );
}

// Keep the drive's idea of "what is selected" in step with the highlighted row.
//
// The NODE goes along with the id. A search result or a recent can be from a collection
// that isn't loaded — or a page that isn't — so an id alone is something the explorer
// cannot resolve, and the commands that act on "the selection" then do nothing at all.

/**
 * How this search box works — shown when, and only when, a search came back empty.
 *
 * That is the one moment the syntax is worth explaining: the user asked for something
 * and got nothing, and "you typed it wrong" is a real possibility they can act on.
 * Showing it any earlier is a permanent instruction panel above an empty drive, and
 * showing it when there ARE results would be explaining a thing that just worked.
 *
 * The text comes from the server's transformer, so it describes the grammar this
 * deployment actually runs rather than the one this file was written against.
 */
// Decided by the `launcherContent` query — whether an offer applies, and what the server
// suggests. This only draws it.
function searchHelp(help, ui) {
  if (!help) return null;
  return div({ className: 'launch-help' },
    help.hint ? div({ className: 'lh-hint' }, icon('info', { size: 13 }), span(help.hint)) : null,
    help.examples.length
      ? div({ className: 'lh-examples' }, ...help.examples.map((ex) =>
        button({ className: 'lh-example', title: ex.label || 'Try this search' },
          span({ className: 'lh-q' }, ex.query),
          ex.label ? span({ className: 'lh-label' }, ex.label) : null,
        ).on({ click: () => activate(ui, ex) })))
      : null,
  );
}




// The trash is the one place "delete" means destroy, so its two verbs live together:
// put it back, or finish the job on this one item. Emptying the whole trash was
// previously the only way to purge anything.


// Substring-first, then subsequence fuzzy score (0 = no match).
