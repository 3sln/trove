# 015 — `await engine.dispatch(...)` sequences nothing

`dispatch()` returns an event feed, not a promise — `DispatchFeed extends EventTarget` with
no `then`, and the body is scheduled on a `setTimeout`. So `await engine.dispatch(x)` is
*guaranteed* to resolve before the action starts.

Six sites do it, one of them eighty lines below the comment in the same class explaining why
it cannot work, and at least one produces a visible bug: the status bar shows a raw `col_…`
id after creating a collection.

The correct shape already exists here, written and tested, at `platform/commands.js:112`:

    await this.dispatch(action).next(['complete', 'error', 'abort'])

## The findings

### `await engine.dispatch(...)` sequences nothing — six sites, one of them 80 lines below the comment warning about it

`web/src/bl/actions.js:189` · high

Two lenses converged and both confirmed it in ngin's source: `DispatchFeed extends EventTarget` with no `then`, and `dispatch()` wraps the body in `setTimeout`, so the awaited action is guaranteed not to have started when the next statement runs. Six sites: actions.js 189, 278, 351, 1318, 1341, 1810. The sharpest is 189, inside the very class whose comment at :108 explains why awaiting a dispatch cannot work. Verified race at 278: `LoadCollectionsAction` writes `explorer.collections` only after `await api.collections()`, while `NavigateAction` writes `collectionId` synchronously — so the status bar's `collectionLabelOf` falls through to the raw `col_…` id. The correct shape already exists in-repo at platform/commands.js:112 under a comment naming this exact trap.

**Fix** — Add one bl helper — `const run = (engine, action) => engine.dispatch(action).next(['complete','error','abort'])` — and use it at 189 and 278 where dependent work follows. At 351, 1318, 1341, 1810 drop the bare `await` so the code stops claiming an order it does not have.

### `activate`'s comment claims it sequences an item's actions; it fires them all concurrently

`web/src/ui/activate.js:21` · medium

'Sequencing them here keeps that out of the item' sits directly above `for (const action of item?.actions || []) ui.engine.dispatch(action);` — and ngin's `dispatch` returns immediately with the body on a `setTimeout`. Two implementations of 'run this item's list of actions' with different semantics, and the one in the render layer asserts an ordering it does not have while platform/commands.js:100 does it correctly under a comment naming the trap. Nothing is visibly broken today because the lists touch independent slices — but bl/launcher.js:245 already emits `[SetLaunchQueryAction, FilterAction]`, and the comment tells the next reader a read-after-write pair here is safe.

**Fix** — Give `activate` the same awaited loop `CommandService.execute` uses, or have items name one choreographing action so the ordering lives in the engine. Either way the comment must stop claiming sequencing.

### `PickAndUpload` / `PickAndInstall` emit `complete` before the work starts, then run on released leases

`web/src/bl/actions.js:1508` · low

`execute` resolves while the OS file dialog is still open, ngin releases the leases in its `finally`, the feed emits `complete` for an upload that has not begun, and the callback then uses `engine`/`explorer` afterwards. The lens honestly downgraded this from medium: the use-after-release is inert by construction (every provider involved is `fromSingleton` and `release` is a documented no-op), and nothing observably depends on the early `complete` today, since both commands resolve to a single action. What survives is honesty of the feed and lease accounting — a real smell, not a live bug.

**Fix** — Promise-ify the pickers and `await` inside `execute`. Note the cost: pickers.js detects cancellation heuristically (focus + 300ms grace + empty files), so the promise must be guaranteed to resolve on that path or the action holds its lease forever and never emits a terminal event — strictly worse than the bug being fixed. Make the cancel path reliable first, or leave this alone.

## Done when

Every finding above is fixed, or struck from this ticket with the reason it was wrong.
