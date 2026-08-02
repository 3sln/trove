// Running a menu item or a list row.
//
// These used to carry a `run` closure — `run: () => ui.engine.dispatch(new ExecCommandAction('explorer.open', node))` —  which
// made a menu item a piece of behaviour wearing a data shape. Nothing could inspect one,
// nothing could contribute one from outside the module that built it, and the engine saw
// only whatever the closure happened to do.
//
// They carry `actions` now: a list of Action instances, which is what an item IS — a label,
// an icon, and what happens if you pick it. Almost all of them turned out to be exactly one
// `ExecCommandAction`, which is the shape the statusItem view already used.
//
// A LIST rather than a single action because a few items genuinely do two things: opening a
// file from the search modal opens it and then closes the modal. Sequencing them here keeps
// that out of the item.

import { runAction } from '../dispatch.js';

/**
 * Run an item's actions, one genuinely finished before the next begins.
 *
 * The loop used to be a bare `ui.engine.dispatch(action)` under a comment claiming it
 * sequenced them — `dispatch` returns a feed and schedules the body, so it fired them all
 * at once. Nothing was visibly broken, because the lists touched independent slices, but
 * bl/launcher.js already emits `[SetLaunchQueryAction, FilterAction]` and the comment was
 * telling the next reader that a read-after-write pair here would be safe.
 *
 * The same shape and the same stop-on-failure rule as CommandService.execute, which is the
 * other implementation of "run this item's list of actions".
 *
 * @param {object} ui
 * @param {{actions?: object[]}} item
 */
export async function activate(ui, item) {
  for (const action of item?.actions || []) {
    const settled = await runAction(ui.engine, action);
    if (settled?.type !== 'complete') break;
  }
}
