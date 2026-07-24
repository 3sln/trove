// The main-panel launcher — search-first "home" that replaces the explorer
// sidebar. Empty query shows recents + a browse list of the current folder; typing
// searches files; a leading `!` switches to command execution; a leading `#`
// filters by tag/property (parsed in the search layer). One keyboard-navigable
// list across whichever mode is active.

import { dd } from '../../runtime.js';
import { icon } from '../icon.js';
import { NavigateAction, OpenFileAction, SearchAction, FilterAction } from '../../bl/actions.js';
import { parseTagQuery, filterLabel } from '../../bl/tagQuery.js';

const { div, span, input, button } = dd;

let searchTimer = null;
function runSearch(ui, query) {
  ui.app.search.set({ query });
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => ui.go(new SearchAction(query)), 240);
}
function runFilter(ui, filters, text) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => ui.go(new FilterAction(filters, text)), 200);
}

export default function launcher(state, ui) {
  const wb = ui.platform.workbench;
  const q = state.wb.launch.query;
  const mode = q.startsWith('!') ? 'command' : q.includes('#') ? 'filter' : 'search';

  const groups = buildContent(state, ui, q, mode);
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
    else if (e.key === 'Escape' && q) { e.preventDefault(); wb.setLaunchQuery(''); ui.app.search.set({ query: '', results: [], ran: false }); }
  };

  let gi = -1;
  return div({ className: 'editor' },
    div({ className: 'launcher' },
      div({ className: 'launch-box' },
        icon(mode === 'command' ? 'command' : mode === 'filter' ? 'tag' : 'search', { size: 18 }),
        input({ className: 'launch-input', value: q, autofocus: true, spellcheck: 'false',
          placeholder: 'Search files · ! run a command · # filter by tag' })
          .on({ input: onInput, keydown: onKey }),
        q ? button({ className: 'launch-clear', title: 'Clear' }, icon('close', { size: 14 }))
          .on({ click: () => { wb.setLaunchQuery(''); ui.app.search.set({ query: '', results: [], ran: false }); } }) : null,
      ),
      div({ className: 'launch-body' },
        ...groups.map((group) => div({ className: 'launch-group' },
          div({ className: 'launch-h' }, span(group.title), group.action || null),
          group.items.length
            ? div({ className: 'launch-list' }, ...group.items.map((it) => itemRow(it, (++gi) === idx)))
            : div({ className: 'launch-empty' }, group.empty || 'Nothing here.'),
        )),
      ),
    ),
  );
}

function itemRow(it, active) {
  return div({ className: `launch-item ${active ? 'active' : ''}` },
    icon(it.icon, { size: 15 }),
    span({ className: 'name' }, it.title),
    it.detail ? span({ className: 'launch-detail' }, it.detail) : null,
    it.badge ? span({ className: 'launch-kind' }, it.badge) : null,
  ).on({ click: it.run, mouseenter: it.hover });
}

function buildContent(state, ui, q, mode) {
  if (mode === 'command') {
    const term = q.slice(1).trim().toLowerCase();
    const items = ui.platform.commands.paletteCommands()
      .map((c) => ({ hay: `${c.category || ''} ${c.title}`.toLowerCase(), c }))
      .map(({ hay, c }) => ({ s: score(hay, term), c }))
      .filter((x) => term === '' || x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map(({ c }) => ({ icon: 'command', title: c.title, detail: c.category, badge: 'command', run: () => ui.exec(c.id) }));
    return [{ title: 'Commands', items, empty: 'No matching commands.' }];
  }

  const { text, filters } = parseTagQuery(q);
  const nodes = (state.se.results || []).map((r) => r.node);

  // Drive-wide tag/property filter (server-side), optionally narrowed by free text.
  if (filters.length) {
    const label = filters.map(filterLabel).join(' ') + (text.trim() ? ` · "${text.trim()}"` : '');
    return [{
      title: state.se.loading ? 'Filtering…' : `Filtered · ${label}`,
      items: nodes.map((n) => (n.kind === 'folder' ? folderItem(n, ui) : fileItem(n, ui))),
      empty: state.se.loading ? 'Filtering…' : 'No files match those filters.',
    }];
  }

  // Free-text search.
  if (text.trim()) {
    return [{
      title: state.se.loading ? 'Searching…' : 'Results',
      items: nodes.map((n) => fileItem(n, ui)),
      empty: state.se.loading ? 'Searching…' : 'No files match.',
    }];
  }

  // Home: recents + browse the current folder.
  const groups = [];
  const recents = (state.wb.recents || []).map((r) => fileItem(r, ui));
  if (recents.length) groups.push({ title: 'Recent', items: recents });

  const ex = state.ex;
  const crumbs = ex.breadcrumb || [];
  const here = crumbs.length ? crumbs[crumbs.length - 1] : null;
  const upAction = here && crumbs.length > 1
    ? button({ className: 'launch-up' }, icon('chevron-left', { size: 13 }), 'Up')
      .on({ click: () => ui.go(new NavigateAction(crumbs[crumbs.length - 2].id)) })
    : null;
  const browse = (ex.items || []).map((n) => (n.kind === 'folder' ? folderItem(n, ui) : fileItem(n, ui)));
  groups.push({
    title: here ? `In ${here.name || '/'}` : 'Files',
    action: upAction,
    items: browse,
    empty: ex.loading ? 'Loading…' : 'This folder is empty.',
  });
  return groups;
}

function fileItem(node, ui) {
  return {
    icon: fileIcon(node),
    title: node.name,
    detail: node.path && node.path !== '/' + node.name ? dirOf(node.path) : (node.contentType || ''),
    run: () => ui.go(new OpenFileAction({ ...node, kind: 'file' })),
  };
}
function folderItem(node, ui) {
  return { icon: 'folder', title: node.name, badge: 'folder', run: () => ui.go(new NavigateAction(node.id)) };
}

function fileIcon(node) {
  const t = node.contentType || '';
  if (t.startsWith('image/')) return 'file-image';
  if (t.startsWith('audio/')) return 'file-audio';
  if (t.startsWith('video/')) return 'file-video';
  return 'file-text';
}
function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
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
