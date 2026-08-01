# 014 — Leases have drifted from what actions actually touch

`static deps` is how an action declares what it may reach, and it is the readability promise
the engine conversion rests on. It is currently documentation rather than a contract:
nothing checks it, and it has already drifted.

One drift is a live crash — install-from-file throws `Cannot read properties of undefined`,
and the caught error tells the user their zip is unreadable. One missing word causes it.

## The findings

### `PickAndInstallPluginAction` never leases `overlay`, so install-from-file dies and blames the zip

`web/src/bl/actions.js:1719` · high

Verified: `static deps = ['notifications','plugins','social','workbench']` while the shared helper `beginInstallFromFile` → `review()` does `r.overlay.set(...)` at pluginInstall.js:58. ngin builds `resources` from exactly the declared entries and no interceptor widens the bag, so `r.overlay` is `undefined`. The URL twin at :1324 declares `overlay`; this one does not. `beginInstallFromFile` wraps `review()` in try/catch, so the user sees "Couldn't read the plugin: Cannot read properties of undefined (reading 'set')" — the message blames a file that read perfectly. One word fixes the bug; the shape is the point (see theme: leases are hand-maintained).

**Fix** — Add `'overlay'`. Then close the class: give `review()` a named parameter list (`review({ notifications, overlay, plugins, social, workbench }, pkg)`) so a missing lease is a missing argument, not a runtime `undefined`, and the `InstallResources` typedef stops being advisory.

### `OpenNotificationTargetAction` calls another action's `execute` by hand and leases five extras, one of which nothing uses

`web/src/bl/actions.js:1276` · medium

The only hand-call of `.execute(` in the whole web package. Five of its nine leases exist solely to feed that call, and `explorer` feeds nothing at all — I traced OpenFileAction's body and `availableOpeners`/`rememberedOpenerId` and none of them touch it. The coupling is invisible: adding a dep to `OpenFileAction` breaks this action at runtime with `undefined`, the identical failure mode as the missing-`overlay` bug in the same file. bl/index.js:49 states the principle it violates: 'a lease that always covers everything tells you nothing about what a piece of work touches.' And an open originating from a notification never reaches the feed while the same open from a row click does.

**Fix** — `await r.engine.dispatch(new OpenFileAction(node)).next(['complete','error','abort']); r.workbench.set({ infoPanel: true });` and cut deps to `['api','engine','notifications','workbench']`. `engine` is already leased, so the change costs nothing.

### Four slice fields that decide real behaviour are written and read but never declared

`web/src/bl/state.js:56` · medium

`explorerState` never declares `selectionNodes`, yet it is the PRIMARY read path in `selectedNodesOf` (services.js:34) with `items` as the fallback — and that function exists specifically to end the class of silent bug where rename/trash/copy-link returned quietly while `hasSelection` said otherwise. `searchState` never declares `filtered`, `offline` or `resolved`, yet `resolved` drives `pickView`. `set` merges anything, so the drift is silent, and state.js presents the initializer as the documentation. Someone reading it to learn what explorer state is gets a wrong answer.

**Fix** — Add the resting values with a one-line note each: `selectionNodes: null`; `filtered: false, offline: false, resolved: null`. Zero behaviour change; the declaration becomes true again. Consider extending sliceCalls.test.js to assert that every key written by a `set` is declared.

### `mediaUrls` is registered as an engine provider that nothing leases

`web/src/bl/index.js:136` · low

Zero `static deps` anywhere names `'mediaUrls'`. Every real consumer reaches the service directly — `ui.platform.mediaUrls`, `this.platform.mediaUrls` in bl/offline.js. The registration advertises that the resource graph governs minted media URLs, and a reader tracing leases finds nobody holds it. Small, but exactly the kind of line that makes the graph not the whole story.

**Fix** — Delete the line and its mirror in web/test/queries.test.js. If media URLs SHOULD be engine-held, that is separate work and should be written, not implied by a registration nothing consumes.

## Done when

Every finding above is fixed, or struck from this ticket with the reason it was wrong.
