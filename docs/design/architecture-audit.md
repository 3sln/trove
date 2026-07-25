# Trove architecture audit

A design review of the whole app (client, server/core, plugin system), run as three
focused audits and synthesized here. Each finding is marked **✅ fixed** (done in this
pass) or **▶ recommended** (a larger refactor left as a deliberate follow-up). Findings
are grouped by theme; severity is the reviewer's.

The through-lines: **three god objects** (`Vfs`, `WorkbenchService`, `PluginHost`),
**pervasive small duplication**, and a **half-committed DI story**. The error model
(`TroveError` → router → client), the storage/metadata interfaces, and the contribution
registry are genuinely clean and were left alone.

---

## 1. Real bugs surfaced by the audit — all ✅ fixed

| # | Bug | Fix |
|---|-----|-----|
| B1 | **`explorer.hasSelection` context key drift** — it gates the Delete keybinding but was only ever written (to `false`) by `NavigateAction`; selecting a file never flipped it true, so Delete could never fire. | Derived from a single `explorer → context` projection in `bl/index.js`; removed the dual-write. Verified: `toggleSelect` now flips the key. |
| B2 | **Upload lifecycle routes skipped the write re-check** — `status/sign/report/part/complete/abort` leaned entirely on the unguessable `uploadId`, so a revoked grant could still drive/commit an upload. | `assertUploadCap` (session `collectionId` + `assertCap`) on every one. Regression test added. |
| B3 | **Sidecar tag-mirror silently swallowed** — `sidecar.setTag` + the queryable `metadata` mirror were two route-level writes with the mirror `.catch(()=>{})`-swallowed, so the two stores could diverge invisibly. | Centralized as `vfs.setTag/removeTag/findByTags` in the façade (one home for the invariant, no swallow); routes call the façade. |

---

## 2. God objects — the highest-value structural debt

### 2a. `Vfs` (core/src/vfs.js) — HIGH ▶ recommended
The "façade" has absorbed a whole indexing subsystem (`indexContributions`,
`removeContributions`, `#applyContribution`, `#indexNode`, `#indexCtx`,
`#runOneIndexer`, `backfillIndexer`, `purgeIndexer` — ~130 lines) plus six trivial
upload pass-throughs.
**Refactor:** extract an `IndexingCoordinator` (owns `indexers`, `search`,
`maxIndexBytes`, the ctx builder, run/backfill/purge) that `Vfs` delegates to; expose
`vfs.uploads` and drop the five forwarders. Small caller surface (`PluginIndexers`, two
routes), well covered by `plugin-indexer.test.js` — the cleanest of the three splits.

### 2b. `WorkbenchService` (web/src/platform/workbench.js) — HIGH ▶ recommended
One service + one subject owns ~10 shell concerns: activity, sidebar, palette,
launcher, modal search, the **panel stack + browser-history sync + recents**, plugin
panel, dialog, context menu, info panel. The modular list-cursor logic is written
twice.
**Refactor:** split into `NavigationService` (stack + history + recents),
`OverlayService` (palette/dialog/contextMenu/pluginPanel/searchModal/`closeOverlays`),
leaving `WorkbenchService` with activity/sidebar/infoPanel. Extract one
`listCursor(index, delta, count)`. **Risk:** the history-sync/stack code is subtle — do
it deliberately with the e2e suite watching.

### 2c. `PluginHost` (web/src/platform/pluginHost.js, 940 lines) — HIGH ▶ recommended
One class owns iframe lifecycle, the host↔plugin RPC router + capability brokering,
viewer/panel/dock placement (building DOM), `navigator.mediaSession`, the heartbeat,
AND install/restore/reconcile/uninstall. Nothing can be tested without a DOM + a
MediaSession + IndexedDB.
**Refactor (proposed seams, each owns disjoint state):** `FrameManager`
(spawn/handshake/destroy, srcdoc/CSP/SDK injection), `CapabilityBroker` + `HostRpcRouter`
(the security-critical `#hostCall`, depending only on a small injected `HostSurface`
interface — `showPanel`/`openFile`/`notify` — so allow/deny is testable with fakes),
`PlacementController`/`DockManager` (`_dockedFrame`, overlays), `MediaController`
(`_mediaOwner`), `InstallManager`, `AvailabilityMonitor`. `PluginHost` shrinks to a thin
orchestrator holding the `plugins` map. **Highest value, highest touch** — the most
fragile subsystem; best done in stages behind the existing plugin e2e (32 checks) +
probe5.

---

## 3. Duplication — mostly ✅ fixed

| Finding | Status |
|---|---|
| `readAll(stream)` reimplemented 4× (vfs, sidecar, indexers, storage/interface) | ✅ one `readAll`/`concatBytes` in `core/util.js` |
| `ALL_CAPABILITIES` byte-identical in client + server | ✅ exported from core, imported narrowly by the client |
| S3 env block copy-pasted for storage + package store | ✅ `s3FromEnv(env, prefix, fallbacks)` |
| `stat → assertCap` shape repeated ~15× (+ a double-stat in `/download`) | ✅ `nodeWithCap(ctx, id, cap)` helper across sidecar/comment/download routes |
| Dead `&& false` creator-role branch; string-literal error codes | ✅ removed / `ErrorCode` + `TroveError.transient()` |
| **Selector matcher** implemented twice (`matchesSelector` vs `matchFromSelector`) with subtle drift (one supports `selector.match`, the other doesn't) | ▶ recommended — share one `selectorMatch(selector, node)` from core |
| **Ext/mime + format tables** duplicated across `openers.extOf`, `contributions.matchesSelector`, `iconForNode`, `offline.isTexty` — already out of sync (e.g. `.svg`, `.mjs`) | ▶ recommended — one `fileType.js` table consumed by all four |
| Default-`textIndexer` registration triplicated (vfs, createVfs, createServer) | ▶ recommended — register it in `IndexerRegistry`'s constructor |
| Reactive-service plumbing (`subject`/`observe`/`#set`) copy-pasted 9× | ▶ recommended — a `ReactiveStore` base (see §4) |

---

## 4. Layering & consistency

- **UI reaches around the action/CQRS layer** (client, MED ▶): the launcher mutates
  `search.set(...)` directly and the command palette calls `api.search` then hangs
  results off `ui._paletteFiles` with a manual `rerender()` — search state ends up with
  three owners. The enabler is that `ExplorerService`/`SearchClientService` expose a
  public `set()` while other services keep it private. **Fix:** a `ReactiveStore` base
  that exposes only intent methods; route palette quick-open through an action.
- **`bl` imported from `ui`** (client, MED): ✅ fixed — `registerBuiltinOpeners` moved
  from `bl/index.js` to `main.js` (the composition layer).
- **Routes reached into `vfs.metadata`** (server, HIGH): ✅ fixed via the `vfs.setTag`
  /`findByTags` façade methods (B3).
- **Context keys dual-written** everywhere (client, HIGH): partially ✅ (the
  `explorer.*` keys are now a projection); the palette/dialog/editor keys are still
  hand-mirrored at each `WorkbenchService` mutator — folds into the 2b split as a
  read-only projection.
- **Opener associations are a bare settings key** (client, MED ▶): they opt out of the
  schema-driven settings model and need a bespoke panel. Model them as a first-class
  schema type or a contribution point so the generated UI owns them.

## 5. DI & extensibility

- **`resolve(value, Base, build)` applied to only ~half the backends** (server, HIGH ▶):
  storage/metadata/embeddings/vectorStore/searchTransformer/identity go through it;
  search/kv/push/collections/packageStore/indexerRuntime use hand-rolled `instanceof`
  ladders. Route every provider through `resolve` (or drop it and standardize on one
  explicit style) so "every backend is pluggable the same way" is real.
- **`/api/capabilities` reports only the primary backend** (server, MED ▶): storage is
  per-collection, so a client picks the wrong upload strategy for a non-default
  collection. Make it collection-scoped and have `SearchService` expose `describe()`
  instead of route-side `constructor.name` introspection.
- **Plugin wire protocol is implicit + the RPC engine is implemented twice** (plugin,
  HIGH ▶): method names are bare strings matched by a `switch`, the sandbox re-hand-rolls
  its own RPC (no per-call timeout), and the init handshake carries **no
  `protocolVersion`**. Introduce a `pluginProtocol.js` shared by both packages (envelope
  + `METHODS` enum + `PROTOCOL_VERSION`); have the SDK reuse a trimmed `RpcChannel`.
- **Capability model scattered across 4 modules** (plugin, HIGH ▶): client `cap()`
  closure (re-created per call), client scope parsing, server `capabilityList`, server
  `assertCapability` (transitional allow-by-default). `accountScoped` (client) and
  `requiresAdmin` (server) even disagree on "needs the server." Consolidate into one
  shared classifier + a single `CapabilityBroker.require(record, cap)`.
- **Legacy `facet`/`documents` vocabulary** threaded through 4 layers as compat shims
  (server, MED ▶): normalize legacy→canonical once at the route boundary and delete the
  interior shims.

---

## 6. Suggested sequencing for the ▶ items

1. **Shared utilities first** (low risk, unblocks the rest): `selectorMatch` +
   `fileType.js` table; `ReactiveStore` base; `textIndexer`-in-registry.
2. **`IndexingCoordinator`** out of `Vfs` (clean boundary, well-tested) — proves the
   god-object remediation pattern.
3. **`resolve`-everything DI** + collection-scoped `/api/capabilities`.
4. **Plugin `pluginProtocol.js` + `CapabilityBroker`** (shared model + versioning)
   before splitting `PluginHost`.
5. **Split `WorkbenchService`**, then **`PluginHost`** — the two highest-touch splits,
   staged behind the e2e + probe suites, last.

Everything in §1 and the ✅ rows of §3–§5 is already committed on this branch.
