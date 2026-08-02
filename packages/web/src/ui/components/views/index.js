// How a list of items is DRAWN.
//
// An opener renders one file; a view renders the results. They register through the
// same contribution system, so "a gallery for a collection full of photographs" is a
// contribution rather than an edit to the launcher — which is the whole point: the
// launcher should not have to know how many ways there are to look at a drive.
//
// A view is the workbench's own: the built-ins, plus whatever a build passes to
// `createWorkbench({ views })`. It runs in the host, so the contract is a dodo vnode.
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
import { SetSettingAction } from '../../../bl/actions.js';
import { SETTING } from '../../../bl/views.js';
import { modeShowsItems } from '../../../bl/launcher.js';
import { selectorMatches } from '@3sln/trove/core/util.js';
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



/** The switcher, shown only when there is more than one way to look at this. */
/**
 * The views that can draw these results, best first.
 *
 * A view with no `match` draws anything — that is what the built-in list and grid are, and
 * why the common case is unfiltered. One that carries a selector is asked about the nodes
 * actually on screen; it survives if it claims any of them, because a mixed result set
 * should still offer the gallery that can draw half of it.
 *
 * `groups` undefined means "not asked" rather than "nothing matches" — a caller that has
 * no results in hand gets the full list, which keeps the switcher stable while a search
 * is still loading instead of blinking out and back.
 */
export function viewsFor(views, groups) {
  if (!groups) return views;
  const nodes = [];
  for (const g of groups) for (const item of g?.items || []) if (item?.node) nodes.push(item.node);
  if (!nodes.length) return views;
  return views.filter((v) => !v.match || nodes.some((n) => selectorMatches(v.match, n)));
}

export function viewSwitcher(slice, current, ui, { mode, groups } = {}) {
  // Two conditions, and the control is furniture without both.
  //
  //   1. The results are FILES. `!` lists commands, and a grid/list toggle over commands
  //      is meaningless — see `modeShowsItems`.
  //   2. More than one view can draw THESE results. A view may carry a selector, so the
  //      count that matters is how many claim what is on screen, not how many are
  //      registered. Same rule the opener chooser follows: ask when there is a choice.
  if (mode !== undefined && !modeShowsItems(mode)) return null;
  const views = viewsFor(slice?.views || [], groups);
  if (views.length < 2) return null;
  return div({ className: 'view-switch' }, ...views.map((v) =>
    button({
      className: `vs-btn ${v.id === current?.id ? 'on' : ''}`,
      title: `${v.title} view`,
      'aria-pressed': v.id === current?.id ? 'true' : 'false',
    }, icon(v.icon || 'list', { size: 14 }))
      .on({ click: () => ui.engine.dispatch(new SetSettingAction(SETTING, v.id)) })));
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
