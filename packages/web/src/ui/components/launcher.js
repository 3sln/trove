// The main-panel launcher — search-first "home" that replaces the explorer
// sidebar. Empty query shows recents + everything in the collection; typing
// searches files; a leading `!` switches to command execution; a leading `#`
// filters by tag/property (parsed in the search layer). One keyboard-navigable
// list across whichever mode is active.

import { dd } from '../../runtime.js';
import { icon } from '../icon.js';
import { CloseSearchModalAction, ExecCommandAction, FilterAction, MoveLaunchAction, OpenFileAction, SearchAction, SelectLaunchAction, SetLaunchIndexAction, SetLaunchQueryAction } from '../../bl/actions.js';
import { parseTagQuery, filterLabel } from '../../bl/tagQuery.js';
import { activeView, renderView, viewSwitcher, viewMove } from './views/index.js';
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

let searchTimer = null;
function runSearch(ui, query) {
  // SearchAction owns search state; the launcher only dispatches (no direct .set).
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => ui.go(new SearchAction(query)), 240);
}
function clearSearch(ui) {
  ui.go(new SetLaunchQueryAction(''));
  ui.go(new SearchAction('')); // empty query resets results/ran/error in the service
}
function runFilter(ui, filters, text) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => ui.go(new FilterAction(filters, text)), 200);
}

export default function launcher(state, ui, opts = {}) {
  const modal = !!opts.modal; // rendered as the double-shift overlay → picks reset the stack
  const q = state.wb.launch.query;
  const mode = q.startsWith('!') ? 'command' : q.includes('#') ? 'filter' : 'search';

  const groups = buildContent(state, ui, q, mode, modal);
  const flat = groups.flatMap((g) => g.items);
  const idx = flat.length ? Math.min(state.wb.launch.index, flat.length - 1) : 0;

  const onInput = (e) => {
    const v = e.target.value;
    ui.go(new SetLaunchQueryAction(v));
    if (v.startsWith('!')) return; // command mode: no query dispatch
    const { text, filters } = parseTagQuery(v);
    if (filters.length) runFilter(ui, filters, text); // drive-wide tag/property query
    else runSearch(ui, text);
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
  const hoverAt = (at) => ui.go(new SetLaunchIndexAction(at));
  // Moving the highlight and selecting what it lands on are one action, not two. The index
  // wraps, so only the store can say where a move ends up — and reading that back out here
  // would read it before the dispatch had applied. See MoveLaunchAction.
  const selectAt = (at) => ui.go(new SelectLaunchAction(at, flat[at]?.node));
  const move = (delta) => ui.go(new MoveLaunchAction(delta, flat.map((i) => i.node)));
  // How the results are drawn right now. The view gets a say in what an arrow key
  // means — one row down is one tile down in a grid, not one tile across — but the
  // index, the selection and the wrapping stay here, so up and down mean the same
  // thing whichever view is showing.
  //
  // The search transformer may have suggested one. Only for an actual search: on the
  // home list there is no sentence to have read.
  const view = activeView(ui.platform, flat, mode === 'search' ? state.se.resolved?.view : null);
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
    else if (e.key === 'Escape' && q) { e.preventDefault(); clearSearch(ui); }
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
        .on({ click: () => clearSearch(ui) }) : null,
      // Only where the browser can transcribe WITHOUT sending audio anywhere. A remote's
      // own mic needs no button from us — it dictates into this field once it is focused,
      // which is what `search.voice` is really for.
      state.voice?.canListen
        ? button({
          className: `launch-mic ${state.voice?.listening ? 'on' : ''}`,
          title: state.voice?.listening ? 'Stop listening' : 'Search by voice',
          'aria-pressed': state.voice?.listening ? 'true' : 'false',
        }, icon('mic', { size: 15 })).on({ click: () => ui.exec('search.voice') })
        : null,
      // Which way to look at the drive. Not in the modal search, where the answer is
      // always "the one thing I am about to press Enter on".
      modal ? null : viewSwitcher(ui.platform, view),
    ),
    showResolved ? resolvedBar(resolved) : null,
    // The results belong to the active view — see ui/components/views. The launcher says
    // WHAT is on screen (these groups, this highlight); the view says how it looks. That
    // split is why a gallery is a contribution rather than another branch in here.
    div({ className: 'launch-body' },
      renderView(view, { groups, index: idx, handlers: { hover: hoverAt, select: selectAt }, state, ui }),
      searchHelp(state, ui, mode),
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
function searchHelp(state, ui, mode) {
  if (mode === 'command') return null;
  const se = state.se;
  if (!se.ran || se.loading || se.error || (se.results || []).length) return null;
  const p = state.caps?.searchPrompt;
  if (!p?.hint && !p?.examples?.length) return null;
  const tryIt = (query) => () => {
    ui.go(new SetLaunchQueryAction(query));
    const { text, filters } = parseTagQuery(query);
    if (filters.length) ui.go(new FilterAction(filters, text));
    else ui.go(new SearchAction(text));
  };
  return div({ className: 'launch-help' },
    p.hint ? div({ className: 'lh-hint' }, icon('info', { size: 13 }), span(p.hint)) : null,
    p.examples?.length
      ? div({ className: 'lh-examples' }, ...p.examples.map((ex) =>
        button({ className: 'lh-example', title: ex.label || 'Try this search' },
          span({ className: 'lh-q' }, ex.query),
          ex.label ? span({ className: 'lh-label' }, ex.label) : null,
        ).on({ click: tryIt(ex.query) })))
      : null,
  );
}

function buildContent(state, ui, q, mode, modal) {
  // Picking anything from the modal search dismisses it; from the home screen there is
  // nothing to dismiss.
  const closeModal = modal ? [new CloseSearchModalAction()] : [];
  if (mode === 'command') {
    const term = q.slice(1).trim().toLowerCase();
    const items = (state.commands || [])
      .map((c) => ({ hay: `${c.category || ''} ${c.title}`.toLowerCase(), c }))
      .map(({ hay, c }) => ({ s: score(hay, term), c }))
      .filter((x) => term === '' || x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map(({ c }) => ({ icon: 'command', title: c.title, detail: c.category, badge: 'command',
        actions: [new ExecCommandAction(c.id), ...closeModal] }));
    return [{ title: 'Commands', items, empty: 'No matching commands.' }];
  }

  const { text, filters } = parseTagQuery(q);
  const nodes = (state.se.results || []).map((r) => r.node);
  const err = state.se.error;

  // A one-click retry so a transient search/filter failure isn't a dead end.
  const retryBtn = (action) => button({ className: 'launch-up', title: 'Retry' }, icon('refresh', { size: 13 }), 'Retry').on({ click: () => ui.go(action) });

  // Drive-wide tag/property filter (server-side), optionally narrowed by free text.
  if (filters.length) {
    const label = filters.map(filterLabel).join(' ') + (text.trim() ? ` · "${text.trim()}"` : '');
    return [{
      title: state.se.loading ? 'Filtering…' : err ? 'Filter failed' : 'Filtered',
      // Shown as typed: a tag is a value, not a heading.
      verbatim: state.se.loading || err ? null : label,
      action: err ? retryBtn(new FilterAction(filters, text)) : null,
      items: nodes.map((n) => fileItem(n, ui, modal, state)),
      empty: state.se.loading ? 'Filtering…' : err ? `Couldn’t filter: ${err}` : 'No files match those filters.',
    }];
  }

  // Free-text search.
  if (text.trim()) {
    return [{
      title: state.se.loading ? 'Searching…' : err ? 'Search failed' : 'Results',
      action: err ? retryBtn(new SearchAction(q)) : null,
      items: nodes.map((n) => fileItem(n, ui, modal, state)),
      empty: state.se.loading ? 'Searching…' : err ? `Couldn’t search: ${err}` : 'No files match.',
    }];
  }

  // Home: recents, then everything in the collection. There is nothing to descend
  // into — this is the "show me everything" fallback for when search isn't the answer.
  const groups = [];
  const recents = (state.nav.recents || []).map((r) => fileItem(r, ui, modal, state));
  if (recents.length) groups.push({ title: 'Recent', items: recents });

  const ex = state.ex;
  const shown = (ex.items || []).length;
  // `stats` is the collection; `items` is the page. When the server didn't report stats
  // we only know the page — and saying "500" while a next page exists is a claim about
  // the drive that is false, so say "500+" instead.
  const knownTotal = ex.stats?.items ?? null;
  const total = knownTotal ?? shown;
  const totalLabel = knownTotal != null ? knownTotal.toLocaleString() : `${shown.toLocaleString()}+`;
  const items = (ex.items || []).map((n) => fileItem(n, ui, modal, state));
  // A partial list must not be titled "All items" — that is a claim about the drive,
  // and on a collection bigger than one page it is false. Say what is on screen, and
  // offer the rest rather than leaving it unreachable.
  if (ex.nextCursor) {
    items.push({
      icon: 'refresh',
      title: ex.loadingMore ? 'Loading…'
        : knownTotal != null ? `Show more (${(knownTotal - shown).toLocaleString()} more)` : 'Show more',
      detail: 'or search to jump straight to something',
      actions: [new ExecCommandAction('explorer.loadMore')],
    });
  }
  // The trash, when it has been opened. Not shown by default: it is a place you go to
  // recover a mistake, not part of browsing the drive.
  if (ex.trash) {
    groups.push({
      // One line, not two: a header reading "0 items" above a body reading "the trash is
      // empty" is the same sentence twice, permanently parked above the drive.
      title: ex.trash.length
        ? `Trash · ${ex.trash.length} item${ex.trash.length === 1 ? '' : 's'}`
        : 'Trash',
      action: div({ className: 'lh-actions' },
        ex.trash.length
          ? button({ className: 'launch-up', title: 'Destroy everything in the trash' },
            icon('trash', { size: 13 }), 'Empty trash').on({ click: () => ui.exec('explorer.emptyTrash') })
          : null,
        // The way back out. Opening the trash used to be one-way until a page reload.
        button({ className: 'launch-up', title: 'Hide the trash' },
          icon('close', { size: 13 }), 'Close').on({ click: () => ui.exec('explorer.hideTrash') }),
      ),
      items: ex.trash.length
        ? ex.trash.map((n) => ({
          icon: 'trash',
          title: n.name,
          detail: `deleted ${new Date(n.deletedAt).toLocaleString()} — restore`,
          actions: [new ExecCommandAction('explorer.restore', n.id)],
          menu: () => trashMenu(n, ui),
        }))
        : [],
      empty: 'The trash is empty.',
    });
  }

  groups.push({
    title: ex.nextCursor ? `All items · showing ${shown.toLocaleString()} of ${totalLabel}` : 'All items',
    // The empty state told people to upload a file, and on desktop and TV there was
    // nothing anywhere that would let them. (Phone has the + in its bottom bar.)
    action: modal ? null : button({ className: 'launch-up', title: 'Upload files to this collection' },
      icon('upload', { size: 13 }), 'Upload').on({ click: () => ui.exec('explorer.upload') }),
    items,
    // Don't show a false "empty" when the load actually FAILED (e.g. server
    // unreachable) — say so, so the user knows to retry rather than believing the
    // collection is empty. (A toast also fires, but the persistent state must be honest.)
    empty: ex.loading ? 'Loading…' : ex.error ? `Couldn’t load this collection: ${ex.error}` : 'Nothing here yet — upload a file to get started.',
  });
  return groups;
}

function fileItem(node, ui, modal, state) {
  return {
    icon: fileIcon(node),
    title: node.name,
    detail: node.contentType || '',
    node,
    // From the modal search, `reset` starts a fresh viewer stack; then close it.
    actions: [
      new OpenFileAction(node, { reset: !!modal }),
      ...(modal ? [new CloseSearchModalAction()] : []),
    ],
    menu: () => fileMenu(node, ui, state),
  };
}

function fileMenu(node, ui, state) {
  const pinned = state.off?.pinnedIds?.has(node.id) ?? false;
  // Ask what the shortcut actually IS. Hardcoding "⌘⇧L" told a Windows or Linux user
  // about a key their machine does not have, and told everyone the default even after
  // they had rebound it.
  const kbd = (id) => state.commandKeys?.[id] || undefined;
  return [
    { label: 'Open', icon: 'file-text', actions: [new ExecCommandAction('explorer.open', node)] },
    { label: 'Download', icon: 'download', actions: [new ExecCommandAction('explorer.download', node)] },
    // Labelled by destination rather than by format: one goes in a document, the other
    // goes to a person.
    { label: 'Copy shareable link', icon: 'link', actions: [new ExecCommandAction('explorer.copyShareLink')] },
    { label: 'Copy trove: link', icon: 'link', kbd: kbd('explorer.copyLink'), actions: [new ExecCommandAction('explorer.copyLink')] },
    { sep: true },
    { label: 'Rename…', actions: [new ExecCommandAction('explorer.rename')] },
    pinned
      ? { label: 'Remove from offline', icon: 'close', actions: [new ExecCommandAction('offline.unpin', node)] }
      : { label: 'Make available offline', icon: 'download', actions: [new ExecCommandAction('offline.pin', node)] },
    { sep: true },
    { label: 'Move to trash', icon: 'trash', danger: true, kbd: kbd('explorer.delete'), actions: [new ExecCommandAction('explorer.delete')] },
  ];
}

// The trash is the one place "delete" means destroy, so its two verbs live together:
// put it back, or finish the job on this one item. Emptying the whole trash was
// previously the only way to purge anything.
function trashMenu(node, ui) {
  return [
    { label: 'Restore', icon: 'refresh', actions: [new ExecCommandAction('explorer.restore', node.id)] },
    { sep: true },
    { label: 'Delete forever', icon: 'trash', danger: true, actions: [new ExecCommandAction('explorer.purgeOne', node.id)] },
  ];
}

function fileIcon(node) {
  const t = node.contentType || '';
  if (t.startsWith('image/')) return 'file-image';
  if (t.startsWith('audio/')) return 'file-audio';
  if (t.startsWith('video/')) return 'file-video';
  return 'file-text';
}

// Substring-first, then subsequence fuzzy score (0 = no match).
function score(hay, term) {
  if (!term) return 1;
  const i = hay.indexOf(term);
  if (i >= 0) return 1000 - i;
  let ti = 0;
  for (let hi = 0; hi < hay.length && ti < term.length; hi++) if (hay[hi] === term[ti]) ti++;
  return ti === term.length ? 1 : 0;
}
