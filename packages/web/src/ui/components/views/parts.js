// The pieces every view draws the same way.
//
// A view decides how results are ARRANGED. It does not get to decide what a group
// header says, or where the row menu opens, because those are the same promises
// whichever way the drive is drawn: the header carries the group's action (Upload,
// Empty trash, Retry) and the menu carries everything you can do to a file. A view that
// dropped either would quietly take working features off the screen.

import { dd } from '../../../runtime.js';
import { icon } from '../../icon.js';
import { ShowContextMenuAction, ToggleItemSelectedAction, ExitSelectionModeAction, ExecCommandAction } from '../../../bl/actions.js';
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
export function menuButton(it, ui, select, state) {
  if (!it.menu) return null;
  // IN SELECTION MODE the `⋯` becomes this item's checkbox, in the same place. Putting the
  // checkbox somewhere else and leaving `⋯` where it was would mean the thing under the
  // cursor is no longer the thing it was a moment ago — and the per-item menu is the wrong
  // verb in a mode where actions apply to everything picked. Those live in the bar above.
  if (state?.ex?.bulk) {
    const on = (state.ex.selection || []).includes(it.node?.id);
    return button({
      className: `launch-more check ${on ? 'on' : ''}`,
      title: on ? `Deselect ${it.title}` : `Select ${it.title}`,
      $attrs: { 'aria-label': on ? `Deselect ${it.title}` : `Select ${it.title}`, 'aria-pressed': on ? 'true' : 'false', role: 'checkbox', 'aria-checked': on ? 'true' : 'false' },
    }, icon(on ? 'check' : 'square', { size: 14 }))
      .on({ click: (e) => { e.stopPropagation(); ui.engine.dispatch(new ToggleItemSelectedAction(it.node)); } });
  }
  return button({
    className: 'launch-more',
    title: `Actions for ${it.title}`,
    $attrs: { 'aria-label': `Actions for ${it.title}` },
  }, icon('dots', { size: 14 }))
    .on({ click: (e) => { e.stopPropagation(); openRowMenu(e.currentTarget, it, ui, null, select); } });
}

/**
 * The bar over a selection: what is picked, and what can be done to all of it.
 *
 * Above the list rather than on a row, because "act on these six" is a different verb from
 * "act on this one" and should not share a place with it. Only actions that MEAN something
 * over many items appear — rename and open-with are single-item verbs and are absent
 * rather than present and disabled, which reads as broken rather than as inapplicable.
 */
export function selectionBar(state, ui) {
  if (!state?.ex?.bulk) return null;
  const n = (state.ex.selection || []).length;
  const act = (label, iconName, command, danger = false) => button({
    className: `sel-act ${danger ? 'danger' : ''}`,
    disabled: !n,
    title: n ? `${label} ${n} item${n === 1 ? '' : 's'}` : `Pick something first`,
  }, icon(iconName, { size: 14 }), span(label))
    .on({ click: () => ui.engine.dispatch(new ExecCommandAction(command)) });

  return div({ className: 'sel-bar' },
    // Says what is selected, including when that is nothing: pressing Delete on an empty
    // selection should visibly do nothing, and the count is what makes that unsurprising.
    span({ className: 'sel-count' }, n ? `${n} selected` : 'Nothing selected'),
    div({ className: 'sel-actions' },
      act('Download', 'download', 'explorer.download'),
      act('Keep offline', 'download', 'offline.pin'),
      act('Delete', 'trash', 'explorer.delete', true),
    ),
    button({ className: 'sel-done', title: 'Done selecting (Esc)' }, icon('close', { size: 14 }), span('Done'))
      .on({ click: () => ui.engine.dispatch(new ExitSelectionModeAction()) }),
  );
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
