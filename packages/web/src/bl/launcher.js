// What the launcher is showing.
//
// This was ~100 lines inside the launcher COMPONENT, deciding — mid-render, where nothing
// else could see it — which nodes are on screen, what each heading says, whether "All
// items" is a lie because another page is waiting, and what the empty state should read
// when a load FAILED as against when the drive is genuinely empty. Every one of those is a
// question about engine state.
//
// It also made a smaller thing impossible: `pickView` needs the nodes on screen, and while
// they were assembled in a render they looked like render-layer data. They are not — they
// come from the explorer and search resources. Deriving them here is what lets the choice
// of view become engine state too.
//
// Groups are DATA. A header control is `{ icon, label, title, actions }`, not a button —
// the launcher used to put a rendered vnode in `group.action`, which is the same
// carrying-a-handle problem that menu items had before they carried `actions`.

import { parseTagQuery, filterLabel } from './tagQuery.js';
import {
  ExecCommandAction, CloseSearchModalAction, OpenFileAction, SearchAction, FilterAction,
  SetLaunchQueryAction,
} from './actions.js';

/** Which mode the typed query puts the launcher in. */
export function launcherMode(query) {
  const q = query || '';
  return q.startsWith('!') ? 'command' : q.includes('#') ? 'filter' : 'search';
}

const iconFor = (node) => {
  const t = node?.contentType || '';
  if (t.startsWith('image/')) return 'file-image';
  if (t.startsWith('audio/')) return 'file-audio';
  if (t.startsWith('video/')) return 'file-video';
  return 'file-text';
};

/**
 * Everything you can do to a file, as descriptions.
 *
 * `pinned` and `keys` are resolved by the caller because both are questions about engine
 * state: whether THIS file is already available offline, and what the shortcut for a
 * command actually is on this machine. Hardcoding "⌘⇧L" told a Windows user about a key
 * they do not have, and told everyone the default even after they had rebound it.
 */
export function fileMenuOf(node, { pinned = false, keys = {} } = {}) {
  const kbd = (id) => keys[id] || undefined;
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

/** What you can do to something already in the trash. */
export function trashMenuOf(node) {
  return [
    { label: 'Restore', icon: 'refresh', actions: [new ExecCommandAction('explorer.restore', node.id)] },
    { sep: true },
    { label: 'Delete forever', icon: 'trash', danger: true, actions: [new ExecCommandAction('explorer.purgeOne', node.id)] },
  ];
}

/**
 * One row for a file.
 *
 * `menu` stays a thunk. A drive can have hundreds of rows on screen and almost none of
 * their menus are ever opened, so building them all would be work nobody asked for — and a
 * pure function deferring pure work is data as much as the array it would have returned.
 */
function fileItem(node, { modal, pinnedIds, keys }) {
  return {
    icon: iconFor(node),
    title: node.name,
    detail: node.contentType || '',
    node,
    // From the modal search, `reset` starts a fresh viewer stack; then close it.
    actions: [
      new OpenFileAction(node, { reset: !!modal }),
      ...(modal ? [new CloseSearchModalAction()] : []),
    ],
    menu: () => fileMenuOf(node, { pinned: pinnedIds.has(node.id), keys }),
  };
}

/**
 * The groups on screen.
 *
 * @param {object} s the slices this reads, already plain
 * @param {boolean} modal whether this is the double-shift overlay rather than the home
 *   screen — the one input that is genuinely about which INSTANCE is rendering, since both
 *   are on screen at once when the overlay is up
 */
export function launcherGroupsOf(s, modal = false) {
  const { ex = {}, se = {}, nav = {}, query = '', commandMatches = [], pinnedIds = new Set(), keys = {} } = s;
  const mode = launcherMode(query);
  const row = (node) => fileItem(node, { modal, pinnedIds, keys });
  const closeModal = modal ? [new CloseSearchModalAction()] : [];

  if (mode === 'command') {
    return [{
      id: 'commands',
      title: 'Commands',
      items: commandMatches.map((c) => ({
        icon: 'command', title: c.title, detail: c.category, badge: 'command',
        actions: [new ExecCommandAction(c.id), ...closeModal],
      })),
      empty: 'No matching commands.',
    }];
  }

  const { text, filters } = parseTagQuery(query);
  const nodes = (se.results || []).map((r) => r.node);
  const err = se.error;
  // A one-click retry so a transient search/filter failure isn't a dead end.
  const retry = (actions) => (err ? [{ icon: 'refresh', label: 'Retry', title: 'Retry', actions }] : []);

  // Drive-wide tag/property filter (server-side), optionally narrowed by free text.
  if (filters.length) {
    const label = filters.map(filterLabel).join(' ') + (text.trim() ? ` · "${text.trim()}"` : '');
    return [{
      id: 'filtered',
      title: se.loading ? 'Filtering…' : err ? 'Filter failed' : 'Filtered',
      // Shown as typed: a tag is a value, not a heading.
      verbatim: se.loading || err ? null : label,
      controls: retry([new FilterAction(filters, text)]),
      items: nodes.map(row),
      empty: se.loading ? 'Filtering…' : err ? `Couldn’t filter: ${err}` : 'No files match those filters.',
    }];
  }

  // Free-text search.
  if (text.trim()) {
    return [{
      id: 'results',
      title: se.loading ? 'Searching…' : err ? 'Search failed' : 'Results',
      controls: retry([new SearchAction(query)]),
      items: nodes.map(row),
      empty: se.loading ? 'Searching…' : err ? `Couldn’t search: ${err}` : 'No files match.',
    }];
  }

  // Home: recents, then everything in the collection. There is nothing to descend into —
  // this is the "show me everything" fallback for when search isn't the answer.
  const groups = [];
  const recents = (nav.recents || []).map(row);
  if (recents.length) groups.push({ id: 'recent', title: 'Recent', items: recents });

  const shown = (ex.items || []).length;
  // `stats` is the collection; `items` is the page. When the server didn't report stats we
  // only know the page — and saying "500" while a next page exists is a claim about the
  // drive that is false, so say "500+" instead.
  const knownTotal = ex.stats?.items ?? null;
  const total = knownTotal ?? shown;
  const totalLabel = knownTotal != null ? knownTotal.toLocaleString() : `${shown.toLocaleString()}+`;
  const items = (ex.items || []).map(row);
  // A partial list must not be titled "All items" — that is a claim about the drive, and on
  // a collection bigger than one page it is false. Say what is on screen, and offer the rest
  // rather than leaving it unreachable.
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
      id: 'trash',
      // One line, not two: a header reading "0 items" above a body reading "the trash is
      // empty" is the same sentence twice, permanently parked above the drive.
      title: ex.trash.length
        ? `Trash · ${ex.trash.length} item${ex.trash.length === 1 ? '' : 's'}`
        : 'Trash',
      controls: [
        ...(ex.trash.length
          ? [{ icon: 'trash', label: 'Empty trash', title: 'Destroy everything in the trash', actions: [new ExecCommandAction('explorer.emptyTrash')] }]
          : []),
        // The way back out. Opening the trash used to be one-way until a page reload.
        { icon: 'close', label: 'Close', title: 'Hide the trash', actions: [new ExecCommandAction('explorer.hideTrash')] },
      ],
      items: (ex.trash || []).map((n) => ({
        icon: 'trash',
        title: n.name,
        detail: `deleted ${new Date(n.deletedAt).toLocaleString()} — restore`,
        actions: [new ExecCommandAction('explorer.restore', n.id)],
        menu: () => trashMenuOf(n),
      })),
      empty: 'The trash is empty.',
    });
  }

  groups.push({
    id: 'all',
    title: ex.nextCursor ? `All items · showing ${shown.toLocaleString()} of ${totalLabel}` : 'All items',
    // The empty state told people to upload a file, and on desktop and TV there was nothing
    // anywhere that would let them. (Phone has the + in its bottom bar.)
    controls: modal ? [] : [{ icon: 'upload', label: 'Upload', title: 'Upload files to this collection', actions: [new ExecCommandAction('explorer.upload')] }],
    items,
    // Don't show a false "empty" when the load actually FAILED (e.g. server unreachable) —
    // say so, so the user knows to retry rather than believing the collection is empty. (A
    // toast also fires, but the persistent state must be honest.)
    empty: ex.loading ? 'Loading…' : ex.error ? `Couldn’t load this collection: ${ex.error}` : 'Nothing here yet — upload a file to get started.',
  });
  return groups;
}

/**
 * The suggestions shown when a search came back with nothing.
 *
 * Two halves, both settled by the `launcherContent` query: whether an offer applies at all
 * — a search ran, it succeeded, it found nothing — and what to suggest, which the server
 * decides and reaches the engine through the `capabilities` resource. Each example carries
 * the actions that run it, so the component only draws them.
 */
export function searchHelpOf({ eligible = false, caps = null } = {}) {
  if (!eligible) return null;
  const p = caps?.searchPrompt;
  if (!p?.hint && !p?.examples?.length) return null;
  return {
    hint: p.hint || null,
    examples: (p.examples || []).map((ex) => {
      const { text, filters } = parseTagQuery(ex.query);
      return {
        query: ex.query,
        label: ex.label || null,
        // Running an example is the same two steps as typing it: put it in the box, then
        // ask whichever of search or filter that spelling means.
        actions: [
          new SetLaunchQueryAction(ex.query),
          filters.length ? new FilterAction(filters, text) : new SearchAction(text),
        ],
      };
    }),
  };
}
