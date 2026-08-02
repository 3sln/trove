// Waiting for a dispatched action to actually finish.
//
// `dispatch(action)` answers an event FEED — `DispatchFeed extends EventTarget`, with no
// `then` — and ngin schedules the body on a `setTimeout`. So `await engine.dispatch(x)`
// resolves immediately and is *guaranteed* to return before the action has started. It
// reads as sequencing and is the opposite of it.
//
// Six sites did it, one of them eighty lines below the comment in the same class explaining
// why it cannot work, and at least one was visible: creating a collection navigated to it
// before the collections list had loaded, so the status bar showed a raw `col_…` id where
// the name belongs.
//
// The completion signal is the terminal event. It RESOLVES with whichever of
// complete/error/abort fired rather than rejecting, so a failing action does not throw at
// the call site — the caller decides whether the next step still makes sense.
//
// Takes anything with a `dispatch`, so the engine and CommandService (which dispatches
// through its own seam) share one implementation instead of two spellings of it.

/**
 * @param {{dispatch: (action: object) => {next: (types: string[]) => Promise<object>}}} dispatcher
 * @param {object} action
 * @returns {Promise<{type: 'complete'|'error'|'abort'}>}
 */
export const runAction = (dispatcher, action) =>
  dispatcher.dispatch(action).next(['complete', 'error', 'abort']);
