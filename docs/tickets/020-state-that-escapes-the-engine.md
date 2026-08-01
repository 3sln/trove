# 020 — State and effects that still escape the engine

The owner's standing concern, in their words: *"things that look like side channels or
escapes from ngin's verdicts."* What the audit found is a short list rather than a pattern —
the conversion mostly holds — but each item is state or an effect the resource graph cannot
see, which is what makes them hard to reason about later.

`window.__trove` is the one to weigh first: it ships unconditionally in the production
bundle.

## The findings

### `window.__trove` ships unconditionally in the production bundle, and its probe surface has already gone stale

`web/src/workbench.js:132` · high

Verified there is no gate: `createWorkbench` has no `debug` option and build.mjs sets no define. This is the one place the entire resource graph — engine, platform, app, plus direct `plugins.install` — is reachable without a dispatch, in the shipped bundle. The staleness is the sharper half: the handle exists to serve e2e, and five calls in test/e2e.mjs go through `window.__trove.platform.workbench.*`, a key platform/index.js no longer has ('It does NOT hold the shell's state'). So the seam is not currently buying the thing that justifies it.

**Fix** — Add a `debug = false` option to `createWorkbench`, set it from the dev-server entry, assign `window.__trove` only when on. Repoint e2e.mjs off `platform.workbench.*` onto `app.navigation`/`app.workbench` — the shape multiuser.e2e.mjs:218 already uses successfully.

### The plugin-review dialog stores an effectful closure in overlay state, contradicting two comments that say it cannot

`web/src/bl/pluginInstall.js:63` · high

Two separate docblocks assert the invariant — actions.js:1199 'Nothing in a dialog spec is callable, which matters because the spec lives in workbench state' and overlays.js:23 'the dialog spec holds no functions' — and this dialog is the sole violation. `onInstall` is an async closure over `r` that clears the overlay, moves the workbench, raises a notification and performs the network install, all after the dispatching action's lease has been released and none of it on the feed. It is also opened by a bare `overlay.set` rather than `ShowDialogAction`, bypassing the action too. The alternative is already available: pluginReview.js keeps its ticked grants in viewState and dispatches `SetViewStateAction` per toggle, so the closure carries only `pkg` and `trust`.

**Fix** — Put `installActions: [new InstallReviewedPluginAction(pkg, trust)]` on the spec; pluginReview.js:64 calls `activate(ui, { actions: d.installActions })`; the new action reads grants from the viewState key the dialog already writes. `pkg` rides on the action instance. Delete the stale paragraph at actions.js:959 while you are there — it says `showDialog`/`showContextMenu` are 'NOT here yet', and both exist and are callback-free.

### The sidecar-flush issue is raised in a shape `canRetry` rejects, and names a handler nobody registers

`core/src/sidecar/manager.js:110` · high

Two lenses, same conclusion. `retry: 'sidecar-flush'` is a bare string; `canRetry` requires `issue.retry.op`, so it is false, so routes.js:636 reports `retryable: false`, so activityPanel.js:89 never renders the button — and if it did, `IssueRegistry.retry` would throw. There is no `issues.handle('sidecar-flush', …)` anywhere; the four registered are reindex-all, scan-collection, storage-check, reindex-node. Both halves are broken independently. The comment two lines above asserts the registration exists, and durability.test.js:66 pins the broken shape — so the next reader has two pieces of evidence that it works. This is the one retry that matters: the user has been told their comment saved and it exists only in memory.

**Fix** — `retry: { op: 'sidecar-flush', nodeId }`; register the handler in server/src/index.js beside the other four; fix durability.test.js:66 to assert `.retry.op`. Make `IssueRegistry.raise` reject a `retry` that is not `{ op: string }` so this is caught at the raise. Also delete `retryable: false` from vfs.js `#note` — `raise` builds a fixed field set without it and routes.js recomputes it anyway.

### `openTroveLink` is a bl function that reaches the platform through the UI bag and does network + notify + dispatch outside any action

`web/src/bl/links.js:22` · high

Two lenses converged; I confirmed by grep that `ui.platform`/`ui.engine` appear in bl/ in exactly three places, all inside this one function. Both defending comments argue for LAZY resolution at click time — sound, and completely unaffected by where the effect runs. What survives: the only bl module whose parameter is a UI-layer shape, performing a network stat, choosing between three failure messages and opening a panel with nothing on the feed, no lease on `api` or `notifications`, and nothing interceptable. pluginHost.js:57 states the opposite rule for the same kind of edge: 'Dispatched, not called: opening a file from a docked plugin frame is the same intent as opening one from the drive, and the engine should see both.'

**Fix** — `class OpenTroveLinkAction extends Action { static deps = ['api','engine','notifications']; }` with the body moved verbatim; `describeBrokenLink` stays the pure helper it already is. markdown.js:216 becomes a dispatch. The one caller discards the return value, so nothing depends on it.

### Escape does not cancel the launcher's pending search dispatch; the debounce is a module-level timer shared by both launcher instances

`web/src/ui/components/launcher.js:36` · medium

Two lenses, and each corrected the other's overreach. `clearSearch` dispatches `SetLaunchQueryAction('')` + `SearchAction('')` and never touches `searchTimer`, so typing then hitting Escape inside 240ms lands `SearchAction('contract')` after the clear. The result LIST is not repopulated (`launcherGroupsOf` reads `wb.launch.query`), but launcher.js:112 renders the resolved bar whenever mode is `'search'` — which `launcherMode('')` is — so 'Searching "contract"' sits over the home list, queries.js:470 turns `ran && !results.length` into the search-help panel, and `pickView` can switch the home view. Independently: `searchTimer` is one module slot shared by the home and modal launchers that workbench.js:94 mounts together, so typing in the modal cancels the home box's pending search. `SearchAction` has no equivalent of `QuickOpenAction`'s staleness guard.

**Fix** — Minimum: `clearTimeout(searchTimer)` in `clearSearch`. Properly: let the UI dispatch only `SetLaunchQueryAction` and give the debounce to a query realization, which has `boot`/`kill` to hang a timer on exactly as `RotationView` hangs its interval — then `searchTimer`, `fileTimer`, `runSearch`, `runFilter`, `clearSearch` and `onQuery` all go.

### `pluginPanel` reads `state.plugins`, which the combined snapshot does not contain

`web/src/ui/components/overlays.js:396` · medium

The snapshot workbench.js:108 builds has no `plugins` key, and `q.plugins` appears only in the pluginsView/adminView/activityBar region query sets. So `state.plugins` is permanently undefined, `|| []` swallows it, and the panel header always shows the raw plugin id where the display name belongs. It is the one component the region split left reading a key nobody supplies — a three-line fix with a visible product symptom.

**Fix** — Make it a region like its neighbours: `pluginPanel: region(engine, { overlay: q.overlay, plugins: q.plugins }, (s) => pluginPanel(s, ui))` and call `regions.pluginPanel()` in `view()`. That also takes it off the main snapshot, which is what regions are for.

### The activity panel's open flag is overlay state living inside the polling service, and network verbs open the panel themselves

`web/src/bl/activity.js:49` · medium

`open: false, // the activity panel` sits in ActivityService's state beside `tasks` and `issues` — the one field with no justification while its neighbours have five lines of it. Every other transient surface is a field of the overlay slice, whose header says exactly that: 'Four things that are independent of the panel stack and of each other… What they are NOT is complex enough to need a service.' The Escape ladder writes five rungs uniformly through `overlay.set`/`workbench.set` and then breaks form on the sixth with `activity.togglePanel(false)`, forcing CloseOverlaysAction to lease the whole task/issue poller to close a panel. And three network verbs (`rebuildIndex`, `scanCollection`, `checkStorage`) each call `togglePanel(true)` as a side effect of a fetch.

**Fix** — Add `activityPanel: false` to `overlayState`, make the toggle an OverlayAction, and let CloseOverlaysAction read it off `o` like the other five rungs. The three `togglePanel(true)` calls become dispatches from RebuildIndexAction / ScanCollectionAction / CheckStorageAction, which is where '…and show the user' belongs. Note `togglePanel(true)` also calls `refresh()`, so that needs to become a bootAction on the activity query or an opened panel shows a list up to 60s stale.

### A plugin viewer's ready/error signal is passed between siblings as functions stamped on DOM nodes

`web/src/ui/components/openers/index.js:183` · medium

`.pv-status`'s `$attach` writes `el._ready` and `el._error` onto the element; the sibling `.pv-host` does `el.parentElement?.querySelector('.pv-status')` and passes `() => status?._ready?.()` into `mountViewer`. Every `?.` in that chain silently no-ops, so reordering or wrapping those two divs leaves the spinner up forever with nothing reporting it. The defending comment justifies `.opaque()` and the fixed-overlay iframe tracking — both real and load-bearing for `.pv-host` — and says nothing about why the STATUS overlay must be imperative. The file's own better answer is sixty lines above: `mediaWithError` uses `cell({ error: null })` + `watch`.

**Fix** — Give `pluginOpenerView` a `cell({ ready: false, error: null })`, pass writers into `mountViewer`, render `.pv-status` from a `watch`. Delete `_ready`, `_error`, the innerHTML assignments, the querySelector and `errorEl`. Leave `.pv-host` opaque and untouched — re-parenting the iframe reloads it.

### `RotationView` is keyed by collection but emits the unscoped `rotation` slice

`web/src/bl/queries.js:185` · low

`this.collectionId` is stored and never used again; `boot` notifies `r.rotation.observe()` whole, and `LoadRotationAction` re-reads the collection from `explorer` rather than from the query, so the query's key means nothing to the value. Note the lens corrected its own fix: a `v.collectionId === this.collectionId` filter at the read does NOT work, because the load stamps the new id before the round trip while leaving the previous collection's `rotation`/`estimate` in place. The genuinely bad case is narrow but persistent: if the load then fails it sets only `{loading:false,error}`, so collection A's running-rotation progress and estimate stay on screen under B's fingerprint indefinitely, with a Start/Stop button beside them.

**Fix** — Fix at the write: `rotation.set({ collectionId, rotation: null, estimate: null, loading: true, error: null })` when the collection changes. Also pass the id in (`new LoadRotationAction(this.collectionId)`) so the load stops depending on `explorer` happening to agree with the query key — which is what makes the key meaningful at all.

### MediaUrlService's mint cache never drops expired entries

`web/src/platform/mediaUrls.js:31` · low

`#flush` inserts into `this.cache` and nothing ever sweeps; `#fresh` only decides whether a HIT is usable, and the sole `invalidate` caller is a media element `error` handler. grid.js mints per pictorial tile, so browsing a large collection leaves an entry per image, none reachable again and none collectable while the page is open. Bounded — only on token-authenticated deployments — which is why it is low.

**Fix** — In `#flush`, before inserting, drop entries whose `expiresAt < Date.now()`; they can never be served again. Two lines. Unlike the interning table in bl/intern.js, evicting here costs a re-mint rather than a duplicate realization, so a hard LRU cap is also safe.

### `Date.now()` wrapped in a try/catch whose fallback would invert the eviction logic

`core/src/sidecar/manager.js:233` · low

`function now() { try { return Date.now(); } catch { return 0; } }` with no comment, while the other 41 `Date.now()` calls in core/src are unguarded and nothing shims `Date`. Three lines implying a hazard that does not exist, whose fallback is wrong in both directions if it ever ran: `lastAccess = 0` makes a hot document look permanently idle, `cutoff = 0 - idleEvictMs` makes every document look permanently fresh. IssueRegistry shows the deliberate alternative — `constructor({ kv, now = () => Date.now() })`.

**Fix** — Delete the helper and call `Date.now()` at the three sites. If a seam is wanted for tests, take `now` on the constructor the way IssueRegistry does — a seam with a purpose rather than a catch for an impossible throw.

### The keybindings region is built at module scope, pinning the first engine it ever sees

`web/src/ui/components/settingsView.js:490` · low

`let kbRegion = null; … kbRegion ??= region(ui.engine, …)`. The comment is right that a region must be built once and wrong about where: at module scope it captures the FIRST `ui`/engine and pins them for the module's life — the shape `watchQuery` deliberately avoids by keying its cache on the engine. The lens explicitly corrected its own overreach here: the region is NOT leaked (dodo's `cleanupTarget` detaches the alias, the watch drops, ngin kills the realizations), so only the placement is wrong. Every other region is built in ui/compositions/workbench.js and handed down — including settingsView's own.

**Fix** — Build it beside the others in the composition and pass it in through `regions`. Folding it into the parent settingsView region also works but costs granularity — a chord capture would re-render the whole settings screen — so passing it down is cheaper.

## Done when

Every finding above is fixed, or struck from this ticket with the reason it was wrong.
