# 017 — Every place Trove grew a second front door, the doors disagree

Surfaces exist in pairs and each pair has drifted, always with the less-trodden one weaker:
HTTP against MCP, Workers against Node/Bun.

The runtime pair is already proven dangerous — only the Worker adapter advanced key
rotations, so a self-hosted drive minted a key, said "running", and moved nothing, forever.
That was fixed by making both schedulers share one function. Two more things have since
landed in one scheduler and not the other.

## The findings

### Node/Bun maintenance never runs the storage self-check, and its scan timer uses the `list(null)` the same file documents as broken

`server/src/index.js:276` · high

The `stepRotations` docblock states the discipline verbatim — 'One function, both callers, so the next thing added to periodic work cannot land in one scheduler and not the other' — and two things have since landed in one and not the other. The Node/Bun interval runs sweepExpired/sidecar.sweep/purgeTrash/stepRotations; `checkStorage` and `notifications.flush()` are Workers-only. Bun is described as the production runtime, so a bucket whose CORS or credentials change is never noticed until an admin opens Activity and presses a button — precisely the outcome index.js:484 says the design rejects. Compounding: the scan timer at :304 uses `collections.list(null)`, which index.js:500 explains 'silently scanned no collection whatsoever' on any non-public drive.

**Fix** — Delete the bespoke interval body: `maintenance = setInterval(() => runMaintenance({ scan: false }).catch(...), everyMs)`. `runMaintenance` already covers everything plus checkStorage and flush, and `scan: false` preserves the opt-in split. Change `scanTimer` to `runMaintenance({ scan: true, budgetMs })`, or at minimum swap `list(null)` for `all()`.

### `warnOnOpenAccess` is wired into the Node and Bun adapters and not into the Worker one

`server/src/adapters/worker.js:36` · medium

Four hits repo-wide: the definition, node.js×2, bun.js×2. `worker.js` `getServer` calls `configFromEnv` then `createServer` and never warns. The condition is satisfied by a default Worker deploy — `configFromEnv` leaves identity anonymous when TROVE_AUTH is unset and `defaultOpen` defaults true. So `wrangler deploy` with no auth yields a world-readable/writable drive on a public URL with a clean log, while the identical config under Bun prints the warning. The docblock calls itself 'Called by the runnable adapters at startup'; worker.js is a runnable adapter.

**Fix** — Call `warnOnOpenAccess(config)` from inside `createServer` and delete the two adapter-side calls — then no future adapter can forget it. It fires per isolate cold start rather than per process, which is noisier only for deployments that really are world-open.

### MCP re-implements collection scoping with the exact behaviour the HTTP route documents as wrong

`server/src/mcp/tools.js:50` · medium

`readable()` filters a named collection out of the readable list; routes.js:1132 spells out the rule right above the identical function — 'A NAMED collection is asserted, not filtered. Filtering an unreadable id out of the list answers "no results" for a collection the caller may not see — indistinguishable from one that is simply empty, so a permissions problem reads as an indexing problem.' mcp/index.js:13 claims 'It is not a second access-control system to keep in sync with the first', and it is exactly that. `ctx.access` is on the MCP ctx, so the assert path is available. `search_files` then tells the model 'No files matched… Try different words' for a forbidden collection, and the model burns turns rephrasing.

**Fix** — Delete `readable` from tools.js; move `readableCollectionIds` into scope.js next to `leaseScope` — already the shared home for 'what both request surfaces need' — and import it from both routes.js and tools.js.

### Two doors on the four resources that stayed services: slices answer `get()`, services expose a public mutable `.state`

`web/src/bl/actions.js:521` · medium

bl/state.js:10 names the problem and claims it fixed: 'TWO DOORS. Actions read `.state` and queries read `.cell`, and the two are only equal by habit… A slice has one value and one way to read it.' Five reads in actions.js still go through `.state` — offline×2, activity, navigation, social — because those four services never got a `get()`. Their write path is already sealed (each has a private `#set`), so only the read door is inconsistent, and `state` is a public field, one typo away from `social.state.sidecar = null` bypassing the cell entirely and notifying nothing. `static deps = ['social']` does not tell an action author which shape arrives. The adjacent defensiveness is itself incoherent: `activity.state?.open` guards, `navigation.state.stack` does not.

**Fix** — Give OfflineService, ActivityService, NavigationService and SocialService a `get()`, rename the field to `#state` (each already has `#set`, so it is mechanical), and change the five call sites. Every engine resource then answers `get()`/`observe()` and sliceCalls.test.js's SLICE_API becomes the universal contract.

## Done when

Every finding above is fixed, or struck from this ticket with the reason it was wrong.
