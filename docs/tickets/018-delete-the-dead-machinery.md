# 018 — Delete the dead machinery that reads as load-bearing

About 400 lines across the four packages are unreachable, and what makes this a ticket rather
than a cleanup pass is that most of it is *advertised* — module headers list it as a feature,
so the next person reaches for it and lands data nothing queries.

The largest item is a complete second reactivity system: `ContextRegistry.watch` / `cellFor`
/ `#slots` plus the whenclause key path, justified by a comment naming the palette as its
beneficiary, where the palette provably takes the other path.

## The findings

### `enabled` on a palette command is provably identical to `available`, has no reader, and its comment describes behaviour the code makes impossible

`web/src/bl/queries.js:348` · medium

queries.js:344 claims 'Collapsing them would tag a command disabled by context as "offline", which is a false explanation' — but `CommandService.paletteCommands()` has already dropped every when-clause failure via `.filter(c => !c.when || this.context.evaluate(c.when))`, and `isEnabled` re-checks the same clause against the same registry object, so for every surviving row `enabled === available` by construction. Grepped every `enabled` in web/src/ui: none is this field; the palette renders only `available`. A comment asserting a distinction the code forecloses is worse than no comment — it tells the reader a context-disabled command appears greyed with a non-offline label, when it never appears at all.

**Fix** — Delete `enabled:` and the paragraph. If the greyed-out-with-a-reason behaviour is wanted, do the other thing: drop the `when` filter from `paletteCommands()` so gated commands reach the view, and render `available === false → 'offline'` vs `enabled === false → 'unavailable here'`. Either is coherent; shipping both halves of neither is not.

### 'isn't available offline' is decided by whether the availability hook is wired, not by being offline

`web/src/platform/commands.js:94` · low

``` `…isn’t available${this.availability ? ' offline' : ''} right now.` ``` asks 'is a hook installed', which platform/index.js:88 makes unconditionally true, so the word 'offline' always prints. `#availableSpec` returns false when a plugin frame is inactive or has stopped answering the heartbeat, before it ever consults `this.online` — so a crashed iframe on a perfectly connected machine tells the user to check their network. bl/queries.js:337 keeps `available` and `enabled` apart specifically to avoid this false explanation; this line is the collapse that comment warns against.

**Fix** — Drop the ternary. If the reason is worth keeping, have `availability` return `null | 'offline' | 'unresponsive'` and render that — but stop deriving user-facing text from whether a seam was assigned.

## Deletions, ranked by payoff over risk

### Delete the whole `ContextRegistry.watch` / `cellFor` / `#slots` / `keysOf` chain

`web/src/platform/context.js`:115

**What goes** — `watch`, `cellFor`, `#slots`, the slot fan-out half of `#changed` (leaving `#changed() { this.#recompute(); }`), the unused `has`, the `derive` import; in whenclause.js, `keysOf`, `Parser#keys` and the two `fn.keys =` assignments; the three tests in web/test/context.test.js that are the only callers. Nothing replaces it — `evaluate` over the whole snapshot is what the app already uses everywhere.

**Payoff** — ~55 lines of source plus three tests, and it removes an entire second reactivity path sitting beside `evaluate`. The real win is the comment: context.js:107 names the palette as the beneficiary, and paletteCommandsOf does the exact opposite — `isEnabled` → `evaluate` per command, recomputed off the whole-snapshot cell. Three lenses found this independently and all three verified the same zero call sites. A dead general mechanism documented as load-bearing costs more than a dead function.

**Risk** — Loses per-clause subscriptions, which would be the right architecture if the palette ever becomes its own region. Cheap to recover: the parser already lexes keys in one pass, so re-deriving is ~25 lines. The only outcome that is not defensible is shipping both halves and using neither.

### Delete every `collections: false` branch — dead config whose every arm falls open

`server/src/routes.js`:1152

**What goes** — `collectionsEnabled` (routes.js:1152), `enforcing` (access.js:33), `enforcing` (mcp/tools.js:40), the `config.collections === false` arm in core.js:532, and each site collapses to its enforcing arm. `readableCollectionIds` loses its `undefined` return and its 'don't scope downstream' contract, which simplifies every caller. Fix README.md:507 while you are there.

**Payoff** — Removes ~8 unreachable predicates from the authorization path across three files. The config cannot exist in a booted server — the `collections` provider throws for it, `collections` is in BACKBONE and leased eagerly, `configFromEnv` throws for TROVE_COLLECTIONS=false, and two tests assert it. Today anyone auditing authz has to prove each fall-open arm unreachable, and each proof lives in another package.

**Risk** — Genuinely removes the ability to run with ACLs off — already removed twice, with tests. The one real loss: a direct-container caller (as three tests do via `createDriveEngine`) passing `collections: false` would get a hard failure instead of a silent fully-open drive. That is an improvement; access.js:260 is evaluated before `collections` is obtained, so today that path is the one place the branch IS reachable and it hands out an open drive.

### One batch delete of dead-but-exported web code

`web/src/bl/actions.js`:1109

**What goes** — Verified zero callers each: `SelectItemsAction` (actions.js:1109, 29 lines), `NotifyAction` (:756), `ApiKeyDraftAction` (:1634 — a byte-for-byte duplicate of `ApiKeysAction`; reparent its three subclasses), `writeToken` (platform/index.js:37), `setSanitizedHtml` (ui/sanitize.js:37), `fromAsync` (runtime.js:45, 22 lines), `CommandService.has` (commands.js:59), `slice.replace` + its justifying paragraph (state.js:29,45) + 'replace' in sliceCalls.test.js's SLICE_API, `watchQuery`'s `initial` option and its paragraph (watchQuery.js:62), `contributionsOfType` + the `ContributionsOfType` class + `ContributionRegistry.observeType`, the `paletteCommands` export, `ContributionRegistry.openerFor`/`ofPlugin`/`unregisterPlugin`, and the dead re-exports (views/index.js:100, workbench.js:8/12/240, bl/index.js:17/171).

**Payoff** — ~200 lines across ten files, most of it in one sitting, with no behaviour change. Several are actively misleading rather than neutral: `SelectItemsAction` carries a hard-won paragraph about an `opts` destructuring bug in an action nothing dispatches, so the next person maintaining selection reads the wrong function (`selectNode` is what runs); `setSanitizedHtml` is the innerHTML-shaped helper `sanitizedVNodes` was explicitly written to retire; `unregisterPlugin` implies a bulk teardown path when uninstall actually runs per-contribution disposers; `slice.replace`'s docstring names two use cases neither of which is a slice.

**Risk** — Small and honest. Six unit-test cases go with the ContributionRegistry and query deletions (contributions.test.js:43,44,75,82,97,99; queries.test.js:212,284,491) — they exist only to test dead exports. `writeToken` is the only writer of the `trove.token` key; nothing signs in today, and multiuser.e2e.mjs:207 shows the intended arrangement is that the embedding page sets it — so add a sentence to `readToken`'s docblock saying so. `fromAsync` is the weakest: runtime.js:69 reads as a deliberate public surface, but `platform.reactive`'s only consumer is pluginHost.js and plugins in frames never receive it. Fold SelectItemsAction's note about carrying `nodes` alongside ids onto `selectNode`.

### Delete `Vfs.getDownload` — the second, weaker copy of the presign-or-proxy rule

`core/src/vfs.js`:539

**What goes** — `getDownload` (~20 lines) and the `handle.download` wiring in access.js:123. Replaced by a predicate the route asks: `canRedirect(node)` → `storage.capabilities.presignDownload && !node.encryption`, with routes.js:398 calling `mintUrl({ op: 'download', download })` when true and `read({ range })` otherwise.

**Payoff** — Collapses a rule that has already produced one shipped bug — server/test/mint-url-encryption.test.js's header is the incident report: '`mintUrl` presigned straight to the store whenever the store COULD, and never asked whether the object was sealed — while `getDownload`, two hundred lines away, has exactly that guard. So on any encrypted collection with a presigning store, every thumbnail, every preview and every URL handed to an external service pointed at CIPHERTEXT.' The surviving divergence (getDownload forwards `expiresIn` raw; mintUrl clamps it) is the next one. One decision, one clamp, one place the encrypted-never-presigns rule is written.

**Risk** — Loses the `ciphertext: true` direct-redirect escape hatch, documented for 'a client that holds the key' — unreachable, since uploads.js:322 records the key no longer leaves the server, and its only use is encryption-roundtrip.test.js:78, which needs updating. `expiresIn`, `d.node` and `d.encryption` have no readers. If ciphertext redirects ever return they belong on `mintUrl` beside `op`.

### Delete the sidecar's `facets` register end to end

`core/src/sidecar/document.js`:99

**What goes** — `setFacet` from document.js and sidecar/index.js (the export at :10 and the service method at :114), `facets` from `emptyDoc`, from the `viewDoc` projection, and from the module header's four-bullet list. Keep the `union(a.facets, b.facets)` line in `mergeDoc` guarded on presence so already-stored documents still merge, or bump SIDECAR_VERSION and drop it there too.

**Payoff** — Two lenses independently grepped this and got the same answer: four hits repo-wide, all definitions, no caller anywhere in core, server, web, plugin-sdk or any test, and no facet verb on the plugin RPC surface. Removes a field from every stored document, a branch from the CRDT merge and a key from every view payload. The header still advertises it as one of the four things a sidecar holds, so it reads as live.

**Risk** — Loses the sidecar as a destination for indexer data — deliberately: indexing.js:71 says 'Indexer contributions live in the queryable metadata store (not the sidecar), so they show up in list/stat and drive tag filtering.' This is the higher-value half: someone extending indexer output finds the documented `facets` bullet first, writes through `setFacet`, and lands data nothing queries. Stored documents with a populated map stop being surfaced by `viewDoc`; no client reads that field.

### Delete `platform.openPluginPanel` — `platform.dispatch` with one action pre-applied

`web/src/bl/index.js`:153

**What goes** — `platform.openPluginPanel` (bl/index.js:153) and the `openPluginPanel: null` placeholder (platform/index.js:82). pluginRpc.js:177 becomes `this.platform.dispatch(new OpenPluginPanelAction(pid))` — or, if you prefer to keep pluginRpc free of bl imports, pass `openPanel` into `new PluginRpcRouter({…})` at pluginHost.js:63 exactly the way `openFile` is passed into FrameDock four lines above.

**Payoff** — Four lenses found this independently. Two lines and one field, but the value is the convention: three seams assigned onto `platform` after construction where two suffice, declared inconsistently (one is a field in the platform literal, the other materialises from nowhere) and guarded inconsistently (`platform.dispatch?.()` optional, `openPluginPanel()` not), so a reader looking for how the plugin layer reaches the engine has to find both. It also stops the fourth field appearing the next time an RPC method needs one.

**Risk** — The layering defence — keep bl/actions.js out of platform/ — is already void: pluginHost.js:30 imports `InvokePluginCommandAction` and `OpenInPanelAction` from `../bl/actions.js` and builds the RPC router. So the direct-import route widens an existing edge rather than creating one. If inverting that dependency is ever on the table, take the injected-callback variant instead. Separately, drop the `?.` at pluginHost.js:60 so an unwired seam fails loudly instead of silently dropping a docked frame's open-file.

### Replace the Node/Bun bespoke maintenance interval with `runMaintenance`

`server/src/index.js`:276

**What goes** — The hand-written interval body (sweepExpired → sidecar.sweep → purgeTrash → collections.all → stepRotations), replaced by `maintenance = setInterval(() => runMaintenance({ scan: false }).catch(...), everyMs)`. `scanTimer` becomes `runMaintenance({ scan: true, budgetMs })` or at minimum swaps its `list(null)` for `all()`.

**Payoff** — ~15 lines go and the two runtimes converge on one function, which is what `stepRotations`'s own docblock demanded: 'One function, both callers, so the next thing added to periodic work cannot land in one scheduler and not the other.' Fixes defect #6 as a side effect — Node/Bun gains `checkStorage` and `notifications.flush()`, and the scan timer stops silently scanning nothing on any non-public drive.

**Risk** — One extra storage preflight per collection per tick (default 5 min) on Node/Bun — the cost the Workers path already pays per cron firing, and index.js:484 already argues it is worth it. `notifications.flush()` gaining a second caller is harmless: index.js:479 says concurrent drains collapse.

### Move `checkStorage` into the provider graph instead of bolting it onto `lifecycleState`

`server/src/engine/providers/core.js`:201

**What goes** — `lifecycleState.storageCheck = checkStorage;` (index.js:222) and the forwarding `storageCheck: Provider.fromSingleton({ run: (opts) => lifecycleState.storageCheck(opts) })`. `checkStorage` moves into core.js as a `fromLazySingleton` with `deps: ['collections','issues','config']`, and `'storageCheck'` joins BACKBONE so `issues.handle('storage-check', …)` and the `server.checkStorage` export still work.

**Payoff** — Removes a seam assigned onto an object after construction — the shape that makes the resource graph not the whole story — and a provider that exists only to forward. `lifecycleState` is left holding only the two things whose late binding is genuinely justified. A reader of core.js stops having to jump packages to learn what `storageCheck.run` is.

**Risk** — Real diff: ~50 lines move out of createServer, and both `issues.handle('storage-check', …)` and the runMaintenance call must read the leased resource instead of a closure. The stated justification for the current shape is specifically wrong — 'it needs `collections` and `issues` from this container' is exactly what `fromLazySingleton` with deps is for, and there is no circularity here, unlike `backgroundWork`, whose comment names a real one ('dispatching needs the engine that owns this container'). Do this one after the cheaper wins.

### Move ActivityService's three network verbs into their actions and delete `this.platform` from the service

`web/src/bl/activity.js`:241

**What goes** — The bodies of `rebuildIndex`, `scanCollection` and `checkStorage` (~60 lines) move into RebuildIndexAction / ScanCollectionAction / CheckStorageAction with `static deps = ['activity','api','notifications']`. `this.platform` disappears from activity.js:36 — I confirmed every one of its thirteen uses is `this.platform.notifications?.…`. The service keeps `refreshTasks`/`refresh`/`togglePanel`/`#followUp` as its surface.

**Payoff** — Three HTTP verbs with panel side effects and eight notification strings stop living inside a resource, and the engine's feed starts seeing calls it currently cannot. Removes the last place a bl resource holds the whole platform bag to reach one subsystem every action already declares as a dep — the exact shape bl/commands.js:8 records as removed ('handlers were closures over `app` … calling services directly, so ExecCommandAction routed the intent into the engine and the handler walked straight back out').

**Risk** — `#followUp` becomes public — a small, real loss of encapsulation. The lens explicitly withdrew the larger version of this proposal: do NOT delete the `ActivityAction` base or the Toggle/Cancel/Dismiss forwarders (actions.js:952 justifies thin actions: 'the feed is the point'), and leave `retryIssue`/`dismissIssue` where they are — they do optimistic rollback over the service's own list, which is genuinely its business. Pairs naturally with defect #24 (moving the `open` flag into the overlay slice).

### Collapse the duplicated icon classifier, body readers, CORS resolvers and trove-URI formatter

`web/src/bl/launcher.js`:30

**What goes** — Four independent one-rule-N-copies collapses, each small: (a) delete `iconFor` in bl/launcher.js and use `iconForKind` from bl/fileType.js — 7 lines, and grid.js:91's override then collapses to `it.icon`; (b) `const readCapped = async (req, max) => new TextDecoder().decode(await readBytesCapped(req, max));` — ~18 lines out of server/src/routes.js; (c) export `corsOriginFor` from router.js and delete `allowedOrigin` from mcp/index.js, which already imports `crossSiteRefusal` from there; (d) add `formatTroveUri({collection, by, value})` in core/src/links.js and have `canonicalTroveUri`, `troveUri`, `extractTroveLinks:117` and `troveUriFromShareUrl:223` all use it — five hand-written copies of one template become one.

**Payoff** — ~50 lines total, and each one is a rule that has ALREADY drifted or is one edit from drifting. The icon pair visibly disagrees today (list vs grid, same node). `readCapped` measures UTF-16 code units where `readBytesCapped` measures bytes, so a multibyte body can exceed the byte cap. Two copies of a CORS allowlist parser is how the API and the MCP endpoint come to disagree about which origins are trusted. `canonicalTroveUri` — the function whose docblock warns 'Two links that address the same item by the same selector must produce the same string, or backlinks would miss…' — is the one place the canonical string is NOT produced from; it has no non-test caller.

**Risk** — Near zero. The icon change makes extension-less, mime-less files show the generic `file` glyph instead of a text-document glyph — which is what every other surface already shows. `readCapped`'s one non-Request caller (routes.js:917, a fetch Response) has both `getReader()` and `arrayBuffer()`, so the collapse is safe. `formatTroveUri` removes no export, so nothing published breaks — it makes the existing exports load-bearing.

### Delete the boot double-fetch and the boot IIFE with an empty `try`

`web/src/workbench.js`:117

**What goes** — (a) `engine.dispatch(new LoadCollectionsAction())` at bl/index.js:166 and the now-unused imports on line 17 — `OpenInitialCollectionAction` fetches and writes the same two fields (`collections`, `canCreateCollection`) on both its normal and share-link paths, so every cold start currently makes two identical GETs to /api/collections and installs two writers for one fact. (b) workbench.js:116-129, an async IIFE whose `try` block contains only a comment; replace the whole thing with the one `engine.dispatch(new OpenInitialCollectionAction());`.

**Payoff** — One redundant network round trip per page load gone, plus 13 lines and an async wrapper around one synchronous call. Both were found by two lenses. The `catch` is not merely dead, it is a claim: a reader looking for where boot verifies the server is reachable finds `Cannot reach the Trove server` and it can never fire — the capability fetch it used to guard moved to the `capabilities` provider, whose rejection arm deliberately swallows.

**Risk** — None. The collection switcher sees an empty list until OpenInitialCollectionAction resolves — the same window as today, just not doubled. `LoadCollectionsAction` keeps its two real callers (CreateCollectionAction, BeginRotationAction). If the paragraph inside the dead `try` is worth keeping, move it next to the `capabilities` provider it describes. Whether boot SHOULD report an unreachable server is a separate decision that belongs to that provider's rejection arm.

### Give `ShowContextMenuAction` an anchor instead of a resolved point

`web/src/ui/components/statusBar.js`:126

**What goes** — `r.top - 8 - items.length * 34` at both statusBar.js sites, and the `window.innerWidth`/`-110`/`120` arithmetic inside `SwitchCollectionAction` (bl/actions.js:1693). The action takes `(anchor, items, { prefer: 'up' })` and `contextMenu()` in overlays.js does all flipping and clamping, since it is the only code that can measure. A keyboard-invoked menu passes no geometry and the overlay centres it.

**Payoff** — Removes the hardcoded 34px row height from two files that must agree — change the CSS row height today and status-bar menus silently overlap their trigger while the overlay's clamp compensates by a different amount. It also gets layout arithmetic out of the bl layer, from a file that carries a `typeof window === 'undefined'` guard precisely because it should not be doing this. Three call sites and one component.

**Risk** — The overlay must handle 'anchored above' as a case rather than receiving an already-negative y — that is the flip logic the callers approximate today, so it moves rather than disappears. The existing comments justifying the CLAMP and the centre-when-unanchored behaviour both survive intact.

### Delete two unreachable route guards and stop `normalizeContribution` running on `clampContribution`'s output

`server/src/routes.js`:741

**What goes** — (a) `if (!ctx.backgroundWork) throw TroveError.unsupported('Reindexing is not available on this deployment')` and its scanning twin — the provider is `Provider.fromSingleton` over an object literal, and the handler never runs if the lease fails, so both branches are unreachable and both messages are false. routes.js:684 already reads the right way for a provider of identical shape. (b) `normalizeContribution(clampContribution(...))` at indexing.js:64 becomes `const { semanticTexts = [], tags = null, metadata = null } = clampContribution(contribution, this.caps);`.

**Payoff** — Two lines plus a call. The `normalizeContribution` one matters more than it looks: contribution.js:11 says 'Both halves of the contract live here because they must not drift' — and `clamp` already does the legacy `documents`/`facet` mapping itself, so the two halves have already drifted into both functions and `normalize` at its only call site can never see a legacy key. All it contributes there is three defaults. Legacy acceptance is untouched, since it lives in `clampContribution`.

**Risk** — The unreachable guards are the anti-pattern this codebase argues against four separate times ('a security check that stands down because a service is missing is one that stops enforcing at the worst possible moment') — deleting them loses nothing. Removing `normalizeContribution` from core/src/index.js:63 would be breaking for out-of-tree consumers; nothing in this repo imports it, but if the export must stay, at minimum stop calling it here and delete its now-duplicated legacy branch. Correct contribution.js's header to say `clamp` normalises and caps in one pass.

### Tighten the ambient request context and two lying route dep declarations

`server/src/index.js`:413

**What goes** — `auth` from the ambient handler ctx (index.js:413) — /api/capabilities already declares `'auth'` as a dep and so receives it twice by two mechanisms; `'collections'` from /api/capabilities' deps (its handler reaches collections through `ctx.access.collection`, from `leaseScope`, not the route lease); `'issues'` from /api/diagnostics/storage' deps (its two-line body uses only `requireWholeDrive` and `ctx.storageCheck`). Leave `mcp` ambient with a one-line comment saying why it is the exception.

**Payoff** — Three tokens, but it restores the property the route table exists for. router.js:69 says the table answers 'what does this endpoint touch', and index.js:406 says the ambient bag is 'Per-request, and nothing else… Handing over vfs, plugins, kv, sqlite and the rest to every handler was a service locator.' Two services are currently exempt from the table and two declarations overstate it, so the table is already not a reliable answer — the entire property it was built for. Same theme as the web-side lease drift, so fix both together.

**Risk** — Near zero for `auth` and the two stale deps. `mcp` is genuinely awkward — it is constructed after the container and would need `backgroundWork`-style late binding for one route, which is not worth it; document the exception rather than engineering around it.

### Delete the per-collection `chunkSize` knob nothing can turn

`core/src/encryption/policy.js`:56

**What goes** — `encryption.chunkSize` reads at vfs.js:180 and uploads.js:202 become `DEFAULT_CHUNK_SIZE` directly, and the runtime guard `if (encrypting && this.partSize % chunkSize !== 0) throw TroveError.internal(...)` becomes a module-level assertion that `DEFAULT_PART_SIZE % DEFAULT_CHUNK_SIZE === 0`.

**Payoff** — Removes a `TroveError.internal` about a mismatch that cannot occur, and stops a reader auditing the encryption code having to trace `normalizeEncryption` to learn that a collection cannot choose its chunk size. `normalizeEncryption` emits exactly `{ enabled, fingerprint, rules }`, and I checked every writer of `c.encryption` in collections/index.js — all three go through it or spread it — so the field is structurally always undefined. Nothing in server, web or plugin-sdk mentions chunkSize at all.

**Risk** — Loses a per-collection setting that was never reachable. The per-OBJECT chunk size is real and separate (`node.encryption.chunkSize`, written by the envelope) and is untouched. If per-collection chunk size is wanted later, add it to `normalizeEncryption`'s output — one place — and the readers become honest.

## Done when

Every finding above is fixed, or struck from this ticket with the reason it was wrong.
