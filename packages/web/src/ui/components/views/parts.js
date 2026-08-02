// The pieces every view draws the same way.
//
// A view decides how results are ARRANGED. It does not get to decide what a group
// header says, or where the row menu opens, because those are the same promises
// whichever way the drive is drawn: the header carries the group's action (Upload,
// Empty trash, Retry) and the menu carries everything you can do to a file. A view that
// dropped either would quietly take working features off the screen.

import { dd } from '../../../runtime.js';
import { icon } from '../../icon.js';
import { ShowContextMenuAction } from '../../../bl/actions.js';
import { activate } from '../../activate.js';

const { div, span, button } = dd;

/**
 * A group's heading.
 *
 * `group.title` is uppercased by CSS, which is right for a label and wrong for anything
 * the user typed — it turns their `#draft` into `#DRAFT`, a tag that isn't what they
 * wrote. So a group can carry a verbatim half.
 */
export function groupHeader(group, ui) {
  const controls = group.controls || [];
  return div({ className: 'launch-h' },
    // Label and value together on the left; `.launch-h` is space-between, so an
    // ungrouped value gets flung to the far edge away from the label it belongs to.
    div({ className: 'lh-title' },
      span(group.title),
      group.verbatim ? span({ className: 'lh-verbatim' }, group.verbatim) : null),
    // Descriptions, not a pre-rendered button. A group used to carry a vnode in `action`,
    // which meant the thing deciding WHAT a header offers had to be able to draw one — the
    // same reason menu items stopped carrying `run` closures. See ui/activate.js.
    controls.length
      ? div({ className: 'lh-actions' }, ...controls.map((c) =>
        button({ className: 'launch-up', title: c.title || c.label },
          c.icon ? icon(c.icon, { size: 13 }) : null, c.label)
          .on({ click: () => activate(ui, c) })))
      : null,
  );
}

/** The "…" button, for items that have a menu. */
export function menuButton(it, ui, select) {
  if (!it.menu) return null;
  return button({
    className: 'launch-more',
    title: `Actions for ${it.title}`,
    $attrs: { 'aria-label': `Actions for ${it.title}` },
  }, icon('dots', { size: 14 }))
    .on({ click: (e) => { e.stopPropagation(); openRowMenu(e.currentTarget, it, ui, null, select); } });
}

/**
 * Open an item's menu, anchored to the thing it belongs to.
 *
 * Anchored to the row (or the pointer, when there was one) rather than to a remembered
 * click position, so the keyboard route lands somewhere sensible too.
 */
export function openRowMenu(anchor, it, ui, event, select) {
  const r = anchor?.getBoundingClientRect?.();
  const x = event?.clientX ?? (r ? r.right - 8 : 0);
  const y = event?.clientY ?? (r ? r.bottom : 0);
  // Read the coordinates BEFORE selecting: selecting re-renders, and `anchor` is then
  // a detached node whose rect is all zeroes.
  const items = it.menu();
  select?.();
  ui.engine.dispatch(new ShowContextMenuAction(items, { x, y }));
}
