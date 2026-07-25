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

### 2a. `Vfs` (core/src/vfs.js) — HIGH ✅ fixed
Extracted an `IndexingCoordinator` (core/indexing.js) owning the whole indexing
subsystem (indexNode, indexContributions, removeContributions, backfillIndexer,
purgeIndexer, the index-context builder, normalizeContribution — ~130 lines). Vfs
constructs one, injecting only `storageFor`, and keeps four thin delegations for its
historical surface, so routes and PluginIndexers are unchanged. Vfs is a genuine
tree/blob/query façade again. (The five trivial upload forwarders were left as-is —
low value.)

### 2b. `WorkbenchService` (web/src/platform/workbench.js) — HIGH ✅ fixed
Split into three focused services: `OverlayService` (palette/dialog/contextMenu/
pluginPanel), `NavigationService` (panel stack + browser-history mirror + recents),
and `WorkbenchService` itself (activity/sidebar/launcher-query/searchModal/infoPanel —
the shell), which composes the other two and coordinates the couplings it must own
(Esc close-order; opening a file sets the home activity + closes modal search, then
delegates). Each sub-service owns its state + subject; the composition zips them and
components read `state.overlay.*` / `state.nav.*`. WorkbenchService went 243 → 134
lines. The duplicated list-cursor logic is one `wrapIndex` helper. Verified across
e2e + offline + mutation/opener probes.

### 2c. `PluginHost` (web/src/platform/pluginHost.js) — HIGH ✅ fixed
Was 969 lines owning iframe lifecycle, the host↔plugin RPC router + capability
brokering, viewer/panel/dock placement (building DOM), `navigator.mediaSession`, the
heartbeat, AND install/restore/reconcile/uninstall. Now an orchestrator (495 lines)
composing four focused collaborators, each owning disjoint state:

| Module | Lines | Owns |
|---|---|---|
| `pluginFrames.js` `FrameManager` | 172 | the sandbox seam: spawn/handshake/destroy, srcdoc + CSP, SDK injection |
| `pluginRpc.js` `PluginRpcRouter` | 259 | the trusted boundary: capability-gated `hostCall`/`hostEvent`, brokered fetch, scoped SQL |
| `pluginDock.js` `FrameDock` | 144 | where a frame is shown (fixed-overlay placement) + the floating dock/PiP (`_dockedFrame`, `_dockEl_`) |
| `pluginMedia.js` `MediaController` | 62 | `navigator.mediaSession` bridging + per-frame handler release (`_mediaOwner`) |

`PluginHost` keeps the lifecycle proper: install/restore/reconcile/uninstall, the
availability heartbeat/probe, `list`/`observe`, and panel/viewer mounting. The teardown
interdependency (frame destroy → placement + media + dock) is resolved by injection: the
dock destroys through the frame manager via a lazy callback, and the frame manager
consults both on destroy. No call site outside the module changed.

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
- **`/api/capabilities` reports only the primary backend** (server, MED ✅ fixed):
  now collection-scoped (`?collection=`, gated on read) with `SearchService.describe()`
  replacing route-side `constructor.name` introspection.
- **Plugin wire protocol was implicit + unversioned** (plugin, HIGH ✅ fixed):
  `plugin-sdk/protocol.js` now defines the envelope, a `METHODS`/`EVENTS` registry, and
  `PROTOCOL_VERSION`. The host sends its version in `init` and checks the SDK's reported
  version on `ready`, failing the handshake on a MAJOR mismatch. Because the SDK is
  injected into the sandbox **as a text blob** (`import … with { type: 'text' }`) it
  can't import the module, so it declares `SDK_PROTOCOL_VERSION` and `protocol.test.js`
  asserts the two stay equal — a drift guard standing in for the import. That test also
  caught a real bug: the SDK's `ctx.commands.execute()` sent a `command:execute` the host
  never handled (always threw); now implemented and gated behind `commands`.
  *Still open:* the SDK hand-rolls its own RPC engine rather than reusing `RpcChannel`
  (same text-injection constraint) — it has no per-call timeout on the plugin side.
- **Capability model spread across modules** (plugin, MED ▶): the `cap()` closure is
  re-created per `hostCall` — now confined to `PluginRpcRouter`, so it's one focused
  unit; folding it into an explicit `CapabilityBroker.require()` is cosmetic from here.
  Note: `accountScoped` (client: "has a server footprint → upload it") and
  `requiresAdmin` (server: "needs admin approval") are **not** a divergence — they answer
  different questions and are correct as-is; `ALL_CAPABILITIES` is already shared. The
  client `capabilityList` (rich per-cap entries for the review UI) is intentionally
  distinct from the server's (a plain list).
- **Legacy `facet`/`documents` vocabulary** threaded through layers as compat shims
  (server, MED ▶): normalize legacy→canonical once at the route boundary and delete the
  interior shims. Low urgency (the shims are inert back-compat).

---

## 6. Sequencing — status

1. ✅ **Shared utilities**: `selectorMatches` (shared), `fileType.js` table,
   `textIndexer`-in-registry. (The `ReactiveStore` base was skipped — marginal DRY
   across divergent services; the concrete layering violations it targeted were fixed
   directly instead.)
2. ✅ **`IndexingCoordinator`** out of `Vfs`.
3. ✅ **`resolve`-everything DI** + collection-scoped `/api/capabilities`.
4. ✅ **UI→service layering** violations closed (launcher/palette route through actions).
5. ✅ **Split `WorkbenchService`** → `WorkbenchService` + `OverlayService` +
   `NavigationService` (243 → 134 lines).
6. ✅ **Plugin protocol module + versioning** (`plugin-sdk/protocol.js`), with a drift
   guard for the text-injected SDK.
7. ✅ **Split `PluginHost`** → orchestrator + `FrameManager` + `PluginRpcRouter` +
   `FrameDock` + `MediaController` (969 → 495 + 4 focused modules).

**All structural findings are resolved.** What remains is deliberately deferred, and
is cosmetic rather than structural:
- folding the `cap()` closure into an explicit `CapabilityBroker.require()` (it's already
  confined to one focused module);
- having the injected SDK reuse `RpcChannel` instead of its own RPC engine — blocked by
  the text-injection constraint, would need a build step.

---

## 7. Follow-on pass: one address space, and a dead-code sweep

Two findings above were symptoms of the same thing, and got a fix bigger than either:

- *"Opener associations are a bare settings key… model them as a contribution point"*
- *"Selector matcher implemented twice"*, *"legacy `facet`/`documents` shims"*

The contribution registry — called out at the top as "genuinely clean" — was in fact a
**collection per kind** (commands, openers, statusItems, keybindings, menus, views,
indexers). That meant a name resolved differently depending on which collection you
asked, three of those collections had zero consumers, and nothing tied a contribution
back to a verifiable owner. It is now **one map of `uri -> contribution`**, each entry
declaring its own `type`; identity is mandatory (`<domain>/<name>`), so every
contribution is addressed as `trove+contrib:<domain>/<plugin>/<name>` and kinds can't
shadow each other. See `server-plugins-and-indexers.md` §3–4.

That also closed the manifest half: `contributes` is one `name -> contribution` map, and
three declarative types that used to be ad-hoc are now first-class — `keymap` (a JSON
file in the package), `statusItem` (a declared slot the plugin fills over RPC, through an
allowlist sanitizer) and `register` (a context value slot a when-clause reads by URI).

A repo-wide dead-code audit ran alongside it. Most findings were ordinary cruft, but
three were bugs wearing cruft's clothes:

| Found as | Actually |
|---|---|
| `MemorySessionStore.sweep` / `SidecarManager.sweep` have no callers | the **only** bound on those caches — abandoned upload sessions and idle sidecar docs grew for the process's life. Now on a maintenance interval. |
| `setLaunchIndex` / `setPaletteIndex` have no callers | the launcher rendered `mouseenter: it.hover` with nothing supplying `hover` — hovering never moved the highlight, so **Enter ran a different row than the one under the cursor**. |
| `offline.chunkText` duplicates `indexers/registry.chunkText` | a *divergent* copy (fixed-width slice vs. boundary-aware), and offline chunks are scored against embeddings the **server** produced — the copy quietly skewed offline results. |

The legacy `facet`/`documents` shims are now gone rather than deferred, along with
`serverIndexers`-as-a-top-level-array and the `contribute:*` runtime registration path
(both dead, and the latter was a hole in "what the user approved is what gets
registered" — a protocol test now asserts neither side can speak it).
