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

export const SETTING = 'explorer.view';

/**
 * The view to draw with, in order of how much someone meant it.
 *
 * 1. A saved choice — they pressed a button. Nothing infers its way past that.
 * 2. The search transformer's hint, when there is a search on screen. It read the
 *    sentence: "photos from the trip last summer" is a request for a gallery as much as
 *    it is a query, and nothing downstream can recover that from a list of content types.
 * 3. A view whose `match` suits what is actually there — a collection of photographs
 *    opens as a grid without anyone asking.
 * 4. The highest priority, which is the list.
 *
 * A hint naming a view this build doesn't have is ignored, not an error: the transformer
 * is deployment configuration and may outlive the build it was written against.
 *
 * PURE. It used to take `platform` and read the contribution registry, the context keys and
 * the settings mid-render — three reads that nothing invalidated on, so the launcher only
 * kept up because the shell's snapshot was coarse enough to redraw it anyway. The reactive
 * half is the `views` query now; what is left is arithmetic over the items already on
 * screen, which is the one input that cannot be a query (there is no sensible key for "these
 * forty search results").
 *
 * @param {{views: Array, saved: string|null}} slice from the `views` query
 * @param {Array} items the rows being drawn, `{ node }`-shaped
 * @param {string|null} hint the search transformer's suggestion, if this is a search
 */
export function pickView({ views = [], saved = null } = {}, items = [], hint = null) {
  if (!views.length) return null;
  const chosen = saved && views.find((v) => v.id === saved);
  if (chosen) return chosen;
  const suggested = hint && views.find((v) => v.id === hint);
  if (suggested) return suggested;
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

/** The switcher, shown only when there is more than one way to look at this. */
export function viewSwitcher(slice, current, ui) {
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
