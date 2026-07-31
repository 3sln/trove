// View state: what the UI is in the middle of doing.
//
// Which keybinding is mid-capture, what has been typed into a dialog that has not been
// submitted, which capabilities are ticked in a plugin review. None of it is drive state —
// it is thrown away when the dialog closes — but all of it decides what is on screen, and
// anything that decides what is on screen is engine state. A component reads it through a
// query and writes it through an action, the same as everything else.
//
// The history is worth keeping because it went wrong twice in the same direction. It began
// as module-level `let`s mutated in place, with a `rerender()` hook threaded through
// fourteen modules so the leaf that changed one could poke the root into redrawing — data
// down, invalidation back up out of band. Moving it into a cell fixed the invalidation and
// left a second version of the same mistake: components still READ it by calling the module
// during their own render, and two of them WROTE to it there as well, to lazily initialise a
// default. A render that writes state is a render with a side effect.
//
// So this is a resource now, and the lazy-initialise trick is gone: where a component used
// to write a default on first render, it now computes one and writes nothing until the user
// does something. `ref` is what makes that possible — it records which dialog instance the
// value belongs to, so a stale entry is simply ignored rather than needing to be cleared.
//
// The holder itself is a slice in bl/state.js; what stays here is how to read one.

/**
 * The slice for `key`, or `fallback` when it belongs to a different dialog instance.
 *
 * Two components keep a draft that must reset when the dialog is reopened. They used to do
 * that by writing the default during the render that noticed the mismatch. Deriving it
 * instead means the render stays a pure function of the state it was given, and the first
 * write happens when the user actually changes something.
 *
 * @param {object} slice the view-state slice from the query
 * @param {string} key
 * @param {object} ref the dialog instance the value must belong to
 * @param {any} fallback
 */
export function draftFor(slice, key, ref, fallback) {
  const held = slice?.[key];
  return held && held.ref === ref ? held : { ref, ...fallback };
}

/** Where a prompt dialog's typed value lives while it is being typed. */
export const PROMPT = 'promptValue';

/**
 * What has been typed into the open prompt, or its initial value.
 *
 * The prompt kept this in a `let` closed over by the render and mutated by the input
 * handler, and handed it back through an `onSubmit` callback — which meant a FUNCTION was
 * living in the dialog spec, and the dialog spec is engine state. Keeping the value here
 * instead lets a prompt carry actions like everything else, and each action reads what was
 * typed rather than being handed it.
 *
 * `ref` ties it to the dialog instance, so reopening starts from the new initial value
 * rather than whatever the last prompt left behind.
 */
export function promptValueOf(slice, dialog) {
  const held = slice?.[PROMPT];
  return held && held.ref === dialog ? held.value : (dialog?.value ?? '');
}
