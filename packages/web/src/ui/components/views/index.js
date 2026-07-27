// How a list of items is DRAWN.
//
// An opener renders one file; a view renders the results. They register through the
// same contribution system, so "a gallery for a collection full of photographs" is a
// contribution rather than an edit to the launcher — which is the whole point: the
// launcher should not have to know how many ways there are to look at a drive.
//
// Unlike an opener, a view is HOST-ONLY: the built-ins, plus whatever a build passes to
// `createWorkbench({ views })`. A plugin cannot declare one, and the reasons are in
// docs/design/views.md — briefly, the results area is where the host's own controls live
// and where the selection that `explorer.delete` acts on comes from, so it is not a
// surface to hand across a sandbox for a feature nobody has asked for yet.
//
// That is also why the contract below is a dodo vnode and not something serializable.
// It is in-process code either way; pretending otherwise would buy a portability nobody
// can use and cost the group headers their host-owned buttons.
//
// The contract is one function:
//
//   render({ groups, index, handlers, state, ui }) -> vnode
//
// `groups` is what the launcher assembled — `[{ title, verbatim?, action?, items,
// empty? }]`, each item `{ icon, title, detail, badge, node?, run() }`. `index` is the
// flat position of the highlighted item across every group, because keyboard
// navigation is the launcher's job and not the view's: up and down must mean the same
// thing whichever way the results happen to be drawn.

import { dd } from '../../../runtime.js';
import { icon } from '../../icon.js';
import { listView } from './list.js';
import { gridView, gridMove } from './grid.js';

const { div, button, span } = dd;

const BUILT_IN = {
  'core.view.list': {
    title: 'List', icon: 'list', priority: 50,
    render: listView,
  },
  'core.view.grid': {
    // Offered first where the results are pictures, and available everywhere.
    title: 'Grid', icon: 'grid', priority: 40,
    match: { mime: ['image/*', 'video/*'] },
    render: gridView, move: gridMove,
  },
};

export function registerBuiltinViews(platform) {
  for (const [name, spec] of Object.entries(BUILT_IN)) {
    platform.contributions.register(name, { type: 'view', ...spec });
  }
}

const SETTING = 'explorer.view';

/**
 * Every view that could draw these results, best first.
 *
 * No availability check, unlike openers: a view is host code, so there is no "its
 * provider isn't answering" state to be in. A when-clause is the only gate, and it is
 * the same one every other contribution answers to.
 */
export function availableViews(platform) {
  return platform.contributions
    .ofType('view')
    .filter((v) => !v.when || platform.context.evaluate(v.when))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

/**
 * The view to draw with.
 *
 * A saved choice wins. Failing that, a view whose `match` suits what is actually on
 * screen — a collection of photographs opens as a grid without anyone asking for it —
 * and failing that, the highest priority, which is the list.
 */
export function activeView(platform, items = []) {
  const views = availableViews(platform);
  if (!views.length) return null;
  const saved = platform.settings.get(SETTING);
  const chosen = saved && views.find((v) => v.id === saved);
  if (chosen) return chosen;
  const nodes = items.map((i) => i.node).filter(Boolean);
  if (nodes.length >= 3) {
    const suits = (v) => v.match && Object.keys(v.match).length
      && nodes.filter((n) => matchesView(v, n)).length / nodes.length > 0.6;
    const fitted = views.find(suits);
    if (fitted) return fitted;
  }
  return views[0];
}

function matchesView(view, node) {
  const ct = node.contentType || '';
  const name = (node.name || '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  if ((view.match.ext || []).includes(ext)) return true;
  return (view.match.mime || []).some((m) => (m.endsWith('/*') ? ct.startsWith(m.slice(0, -1)) : ct === m));
}

export function chooseView(platform, viewId) {
  platform.settings.set(SETTING, viewId || undefined);
}

/** The switcher, shown only when there is more than one way to look at this. */
export function viewSwitcher(platform, current) {
  const views = availableViews(platform);
  if (views.length < 2) return null;
  return div({ className: 'view-switch' }, ...views.map((v) =>
    button({
      className: `vs-btn ${v.id === current?.id ? 'on' : ''}`,
      title: `${v.title || v.name} view`,
      'aria-pressed': v.id === current?.id ? 'true' : 'false',
    }, icon(v.icon || 'list', { size: 14 })).on({ click: () => chooseView(platform, v.id) })));
}

/**
 * Draw the results with `view`, falling back to the list if it throws.
 *
 * A view is the whole results area. One that fails takes the drive's contents off the
 * screen with it, so a broken third-party view degrades to the built-in list rather
 * than to nothing.
 */
/**
 * The delta an arrow key should move the highlight by, or null for the default.
 *
 * Keyboard navigation stays the launcher's: it owns the index, the selection and the
 * wrapping. But "down" means the row below in a list and the tile below in a grid, so
 * the view is asked first and answers in the launcher's own terms.
 */
export function viewMove(view, key, ctx) {
  try {
    const d = view?.move?.({ key, ...ctx });
    return Number.isFinite(d) && d !== 0 ? d : null;
  } catch {
    return null; // a view that can't answer doesn't get to break the arrow keys
  }
}

export function renderView(view, ctx) {
  try {
    if (typeof view?.render === 'function') return view.render(ctx);
  } catch (err) {
    console.error(`view "${view?.id}" failed`, err);
    return div({},
      div({ className: 'view-error' }, icon('warn', { size: 13 }),
        span(`The “${view?.title || view?.id}” view could not be drawn — showing the list instead.`)),
      listView(ctx));
  }
  return listView(ctx);
}

export { listView, gridView };
