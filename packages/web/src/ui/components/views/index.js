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
export function viewSwitcher(slice, current, ui, { mode } = {}) {
  // Two conditions, and the control is furniture without both.
  //
  //   1. The results are FILES. `!` lists commands, and a grid/list toggle over a list of
  //      commands is meaningless — see `modeShowsItems`. This is the one that was missing.
  //   2. There is more than one view.
  //
  // Not, note, "more than one view MATCHES these results". A view's `match` is a
  // PREFERENCE, not a restriction — the grid declares `image/*` to be offered first where
  // the results are pictures, and is available everywhere regardless. Filtering by it hid
  // the grid on a drive of audiobooks, which is the opposite of the point. If a view ever
  // needs to say "I cannot draw this", that wants its own field rather than a reused one.
  if (mode !== undefined && !modeShowsItems(mode)) return null;
  const views = slice?.views || [];
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
