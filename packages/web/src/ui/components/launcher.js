// The main-panel launcher — search-first "home" that replaces the explorer
// sidebar. Empty query shows recents + everything in the collection; typing
// searches files; a leading `!` switches to command execution; a leading `#`
// filters by tag/property (parsed in the search layer). One keyboard-navigable
// list across whichever mode is active.

import { dd } from '../../runtime.js';
import { icon } from '../icon.js';
import { OpenFileAction, SearchAction, FilterAction } from '../../bl/actions.js';
import { parseTagQuery, filterLabel } from '../../bl/tagQuery.js';

const { div, span, input, button } = dd;

// What to put in the search box, and how much of it fits.
//
// The server tells us, because the search TRANSFORMER decides what the box accepts and
// that is deployment configuration — swap in an LLM transformer and "# filter by tag"
// stops being the right advice. The fallback covers the moment before capabilities
// arrive and any server too old to say; `!` is ours either way, since running a command
// from here is a client convention the server knows nothing about.
function promptFor(ui, { compact = false, modal = false } = {}) {
  const p = ui.platform.capabilities?.searchPrompt;
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
  ui.platform.workbench.setLaunchQuery('');
  ui.go(new SearchAction('')); // empty query resets results/ran/error in the service
}
function runFilter(ui, filters, text) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => ui.go(new FilterAction(filters, text)), 200);
}

export default function launcher(state, ui, opts = {}) {
  const wb = ui.platform.workbench;
  const modal = !!opts.modal; // rendered as the double-shift overlay → picks reset the stack
  const q = state.wb.launch.query;
  const mode = q.startsWith('!') ? 'command' : q.includes('#') ? 'filter' : 'search';

  const groups = buildContent(state, ui, q, mode, modal);
  const flat = groups.flatMap((g) => g.items);
  const idx = flat.length ? Math.min(state.wb.launch.index, flat.length - 1) : 0;

  const onInput = (e) => {
    const v = e.target.value;
    wb.setLaunchQuery(v);
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
  const hoverAt = (at) => wb.setLaunchIndex(at);
  const selectAt = (at) => { wb.setLaunchIndex(at); syncSelection(ui, flat[at]); };
  const move = (delta) => {
    wb.moveLaunch(delta, flat.length);
    syncSelection(ui, flat[wb.state.launch.index]);
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); flat[idx]?.run(); }
    else if (e.key === 'Escape' && q) { e.preventDefault(); clearSearch(ui); }
    // The row under the highlight is the subject of the row menu, so the key that opens
    // one on every other list opens this one too — without making the user leave the
    // search box to reach it.
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const it = flat[idx];
      // Arrowing here already selected the row, so the menu acts on the right thing.
      if (it?.menu) { e.preventDefault(); openRowMenu(document.querySelector('.launch-item.active'), it, ui); }
    }
  };

  // What the server actually searched (transformer output) — shown when it differs
  // from what the user typed, so an LLM-assisted transform stays honest.
  const resolved = mode === 'search' ? state.se.resolved : null;
  const showResolved = resolved && (resolved.source === 'llm'
    || (resolved.tagFilters && resolved.tagFilters.length)
    || (resolved.semanticText || '').trim() !== q.trim());

  let gi = -1;
  const inner = div({ className: 'launcher' },
    div({ className: 'launch-box' },
      icon(mode === 'command' ? 'command' : mode === 'filter' ? 'tag' : 'search', { size: 18 }),
      input({ className: 'launch-input', value: q, autofocus: true, spellcheck: 'false',
        placeholder: promptFor(ui, { compact: state.vp?.mode === 'phone', modal }) })
        .on({ input: onInput, keydown: onKey }),
      q ? button({ className: 'launch-clear', title: 'Clear' }, icon('close', { size: 14 }))
        .on({ click: () => clearSearch(ui) }) : null,
    ),
    showResolved ? resolvedBar(resolved) : null,
    div({ className: 'launch-body' },
      ...groups.map((group) => div({ className: 'launch-group' },
        // `group.title` is uppercased by CSS, which is right for a label and wrong for
        // anything the user typed — it turns their `#draft` into `#DRAFT`, a tag that
        // isn't what they wrote. So a group can carry a verbatim half.
        div({ className: 'launch-h' },
          // Label and value together on the left; `.launch-h` is space-between, so an
          // ungrouped value gets flung to the far edge away from the label it belongs to.
          div({ className: 'lh-title' },
            span(group.title),
            group.verbatim ? span({ className: 'lh-verbatim' }, group.verbatim) : null),
          group.action || null),
        group.items.length
          ? div({ className: 'launch-list' }, ...group.items.map((it) => {
            const at = ++gi;
            return itemRow(it, at === idx, { hover: () => hoverAt(at), select: () => selectAt(at) }, ui);
          }))
          : div({ className: 'launch-empty' }, group.empty || 'Nothing here.'),
      )),
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

function itemRow(it, active, { hover, select }, ui) {
  const row = div({ className: `launch-item ${active ? 'active' : ''}` },
    icon(it.icon, { size: 15 }),
    span({ className: 'name' }, it.title),
    it.detail ? span({ className: 'launch-detail' }, it.detail) : null,
    it.badge ? span({ className: 'launch-kind' }, it.badge) : null,
    // Everything you can do to a file, on the file. Rename, download, copy link and
    // delete were all commands with no way to reach them: the palette's versions act on
    // "the selection", and until the highlight became a selection there never was one.
    it.menu
      ? button({ className: 'launch-more', title: `Actions for ${it.title}`, $attrs: { 'aria-label': `Actions for ${it.title}` } }, icon('dots', { size: 14 }))
        .on({ click: (e) => { e.stopPropagation(); openRowMenu(e.currentTarget, it, ui, null, select); } })
      : null,
  // One `.on()` call: a second replaces the handler map rather than merging into it,
  // which is how adding `contextmenu` silently removed `click` and stopped every file
  // in the drive from opening.
  ).on({
    click: it.run,
    mouseenter: hover,
    ...(it.menu ? { contextmenu: (e) => { e.preventDefault(); openRowMenu(e.currentTarget, it, ui, e, select); } } : {}),
  });
  return row;
}

// Anchor the menu to the row (or the pointer, when there was one) rather than to a
// remembered click position, so the keyboard route lands somewhere sensible too.
function openRowMenu(anchor, it, ui, event, select) {
  const r = anchor?.getBoundingClientRect?.();
  const x = event?.clientX ?? (r ? r.right - 8 : 0);
  const y = event?.clientY ?? (r ? r.bottom : 0);
  // Read the coordinates BEFORE selecting: selecting re-renders, and `anchor` is then
  // a detached node whose rect is all zeroes.
  const items = it.menu(ui);
  select?.();
  ui.platform.workbench.showContextMenu(x, y, items);
}

// Keep the drive's idea of "what is selected" in step with the highlighted row.
function syncSelection(ui, item) {
  ui.app.explorer.select(item?.node?.id ? [item.node.id] : []);
}

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
  const p = ui.platform.capabilities?.searchPrompt;
  if (!p?.hint && !p?.examples?.length) return null;
  const wb = ui.platform.workbench;
  const tryIt = (query) => () => {
    wb.setLaunchQuery(query);
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
  const done = () => { if (modal) ui.platform.workbench.closeSearchModal(); };
  if (mode === 'command') {
    const term = q.slice(1).trim().toLowerCase();
    const items = ui.platform.commands.paletteCommands()
      .map((c) => ({ hay: `${c.category || ''} ${c.title}`.toLowerCase(), c }))
      .map(({ hay, c }) => ({ s: score(hay, term), c }))
      .filter((x) => term === '' || x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map(({ c }) => ({ icon: 'command', title: c.title, detail: c.category, badge: 'command', run: () => { ui.exec(c.id); done(); } }));
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
      items: nodes.map((n) => fileItem(n, ui, modal)),
      empty: state.se.loading ? 'Filtering…' : err ? `Couldn’t filter: ${err}` : 'No files match those filters.',
    }];
  }

  // Free-text search.
  if (text.trim()) {
    return [{
      title: state.se.loading ? 'Searching…' : err ? 'Search failed' : 'Results',
      action: err ? retryBtn(new SearchAction(q)) : null,
      items: nodes.map((n) => fileItem(n, ui, modal)),
      empty: state.se.loading ? 'Searching…' : err ? `Couldn’t search: ${err}` : 'No files match.',
    }];
  }

  // Home: recents, then everything in the collection. There is nothing to descend
  // into — this is the "show me everything" fallback for when search isn't the answer.
  const groups = [];
  const recents = (state.nav.recents || []).map((r) => fileItem(r, ui, modal));
  if (recents.length) groups.push({ title: 'Recent', items: recents });

  const ex = state.ex;
  const shown = (ex.items || []).length;
  // `stats` is the collection; `items` is the page. When the server didn't report stats
  // we only know the page — and saying "500" while a next page exists is a claim about
  // the drive that is false, so say "500+" instead.
  const knownTotal = ex.stats?.items ?? null;
  const total = knownTotal ?? shown;
  const totalLabel = knownTotal != null ? knownTotal.toLocaleString() : `${shown.toLocaleString()}+`;
  const items = (ex.items || []).map((n) => fileItem(n, ui, modal));
  // A partial list must not be titled "All items" — that is a claim about the drive,
  // and on a collection bigger than one page it is false. Say what is on screen, and
  // offer the rest rather than leaving it unreachable.
  if (ex.nextCursor) {
    items.push({
      icon: 'refresh',
      title: ex.loadingMore ? 'Loading…'
        : knownTotal != null ? `Show more (${(knownTotal - shown).toLocaleString()} more)` : 'Show more',
      detail: 'or search to jump straight to something',
      run: () => ui.exec('explorer.loadMore'),
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
          run: () => ui.exec('explorer.restore', n.id),
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

function fileItem(node, ui, modal) {
  return {
    icon: fileIcon(node),
    title: node.name,
    detail: node.contentType || '',
    node,
    // From the modal search, `reset` starts a fresh viewer stack; then close it.
    run: () => {
      ui.go(new OpenFileAction(node, { reset: !!modal }));
      if (modal) ui.platform.workbench.closeSearchModal();
    },
    menu: () => fileMenu(node, ui),
  };
}

function fileMenu(node, ui) {
  const pinned = (ui.app.offline?.state?.pins || []).some((p) => p.id === node.id);
  // Ask what the shortcut actually IS. Hardcoding "⌘⇧L" told a Windows or Linux user
  // about a key their machine does not have, and told everyone the default even after
  // they had rebound it.
  const kbd = (id) => ui.platform.keybindings.labelFor(id) || undefined;
  return [
    { label: 'Open', icon: 'file-text', run: () => ui.exec('explorer.open', node) },
    { label: 'Download', icon: 'download', run: () => ui.exec('explorer.download', node) },
    { label: 'Copy link', icon: 'link', kbd: kbd('explorer.copyLink'), run: () => ui.exec('explorer.copyLink') },
    { sep: true },
    { label: 'Rename…', run: () => ui.exec('explorer.rename') },
    pinned
      ? { label: 'Remove from offline', icon: 'close', run: () => ui.exec('offline.unpin', node) }
      : { label: 'Make available offline', icon: 'download', run: () => ui.exec('offline.pin', node) },
    { sep: true },
    { label: 'Move to trash', icon: 'trash', danger: true, kbd: kbd('explorer.delete'), run: () => ui.exec('explorer.delete') },
  ];
}

// The trash is the one place "delete" means destroy, so its two verbs live together:
// put it back, or finish the job on this one item. Emptying the whole trash was
// previously the only way to purge anything.
function trashMenu(node, ui) {
  return [
    { label: 'Restore', icon: 'refresh', run: () => ui.exec('explorer.restore', node.id) },
    { sep: true },
    { label: 'Delete forever', icon: 'trash', danger: true, run: () => ui.exec('explorer.purgeOne', node.id) },
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
