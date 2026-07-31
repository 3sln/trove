// Running a menu item or a list row.
//
// These used to carry a `run` closure — `run: () => ui.exec('explorer.open', node)` —  which
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

/**
 * @param {object} ui
 * @param {{actions?: object[]}} item
 */
export function activate(ui, item) {
  for (const action of item?.actions || []) ui.go(action);
}
