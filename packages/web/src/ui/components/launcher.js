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
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); wb.moveLaunch(1, flat.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); wb.moveLaunch(-1, flat.length); }
    else if (e.key === 'Enter') { e.preventDefault(); flat[idx]?.run(); }
    else if (e.key === 'Escape' && q) { e.preventDefault(); clearSearch(ui); }
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
            return itemRow(it, at === idx, () => ui.platform.workbench.setLaunchIndex(at));
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

function itemRow(it, active, hover) {
  return div({ className: `launch-item ${active ? 'active' : ''}` },
    icon(it.icon, { size: 15 }),
    span({ className: 'name' }, it.title),
    it.detail ? span({ className: 'launch-detail' }, it.detail) : null,
    it.badge ? span({ className: 'launch-kind' }, it.badge) : null,
  ).on({ click: it.run, mouseenter: hover });
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
  const total = ex.stats?.items ?? shown;
  const items = (ex.items || []).map((n) => fileItem(n, ui, modal));
  // A partial list must not be titled "All items" — that is a claim about the drive,
  // and on a collection bigger than one page it is false. Say what is on screen, and
  // offer the rest rather than leaving it unreachable.
  if (ex.nextCursor) {
    items.push({
      icon: 'refresh',
      title: ex.loadingMore ? 'Loading…' : `Show more (${(total - shown).toLocaleString()} more)`,
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
      items: ex.trash.length
        ? ex.trash.map((n) => ({
          icon: 'trash',
          title: n.name,
          detail: `deleted ${new Date(n.deletedAt).toLocaleString()} — restore`,
          run: () => ui.exec('explorer.restore', n.id),
        }))
        : [],
      empty: 'The trash is empty.',
    });
  }

  groups.push({
    title: ex.nextCursor ? `All items · showing ${shown.toLocaleString()} of ${total.toLocaleString()}` : 'All items',
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
    // From the modal search, `reset` starts a fresh viewer stack; then close it.
    run: () => {
      ui.go(new OpenFileAction(node, { reset: !!modal }));
      if (modal) ui.platform.workbench.closeSearchModal();
    },
  };
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
