# Server-installed plugins & server indexers — design

Status: **spec / not yet built.** This consolidates the design for (a) moving plugin
execution and installation server-side where required, (b) a real server indexer
pipeline that runs untrusted plugin code in isolates, (c) a presigned read URL in the
indexer SDK, and (d) explicit install scopes with authorization.

It builds directly on the per-contributor contribution model already shipped
(`semanticTexts` / `tags` / `metadata`, namespaced per contributor, merged for
filtering, removable per contributor).

---

## 1. Current state (what exists vs. what this replaces)

- **Contributions (built):** an indexer/user/plugin writes a namespaced
  `{ semanticTexts, tags, metadata }`. Built-in indexers (`textIndexer`) run
  server-side on upload via `Vfs.#indexNode`. `Vfs.removeContributions(node, id)`
  reverses one contributor cleanly.
- **Plugin indexers — ✅ built:** declared in the manifest (a `type: "indexer"` contribution,
  each naming an entry module) and run **server-side** by `PluginIndexers` +
  `IndexerRuntime` on every upload, with backfill on install and purge on uninstall.
  The old client-side `ctx.contributes.indexer` + `indexer:run` path was dead code —
  nothing ever triggered it — and has been removed.
- **Plugin storage & install (client-trusted):** plugins live in the browser
  (`PluginRegistry`, IndexedDB). The server never sees the package; it holds only the
  scoped SQLite keyed by `(user, pluginId)`. `POST /api/plugins/:id/sql` checks only
  that a principal exists — **it does not verify the plugin is installed or was granted
  `storage`.** Capability enforcement is entirely client-trusted today.

This design makes the **server the source of truth** for anything with a server
footprint, and adds a real, sandboxed server indexer pipeline.

---

## 2. Install scopes & authorization

Two orthogonal facts about a plugin decide its install scope: does it run **code on
the server** (server indexers), and does it have a **server footprint** (server
storage) and of what kind (private-per-user vs. shared).

| Scope | What it means | Allowed capabilities | Who installs |
|---|---|---|---|
| **Device** | Package lives only in the browser (IndexedDB); unsynced. No server trace. | client-only: `ui`, `commands`, `opener`, `dock`, `media`, on-device (wasm) storage, client indexers | user |
| **Account (self-serve)** | Full package uploaded to the server; synced across the user's devices; server manages its data + enforces caps. Executes **no** server code and touches **no** shared resources. | above + private per-user server `storage`, brokered `network` (declared endpoints), `files` the user can already access | **user** (own account) |
| **Account (admin-gated)** | As above, plus server-executed code and/or shared state. | above + **server `indexer`**, **`storage.domain`** (shared), any workspace/cross-user resource | **admin** |

**The gate rule:** admin approval is required **iff** the plugin declares a server
indexer *or* a shared-resource capability. Otherwise "it only touches what the user can
already touch" → the user self-installs on their own account. Device-only is reserved
for plugins with **zero** server footprint.

Note a plugin may be client-code-only yet still be an *account* install because it uses
private server storage — anything with a server footprint uploads the full package so
the server can sync it, enforce its caps, and clean it up.

---

## 3. Two URI schemes, one idea

Trove addresses things it doesn't own the naming of with URIs, and there are exactly
two:

| scheme | addresses | example |
| --- | --- | --- |
| `trove:` | an **item** in the drive | `trove:default?name=sailing.txt` |
| `trove+contrib:` | a **contribution** from a package | `trove+contrib:acme.com/docs/pdfViewer` |

Both exist for the same reason: something outside the code — a markdown document, a
manifest, a when-clause — needs to name a thing unambiguously and durably. Content
links use `trove:` (see the main README and `../../packages/core/src/links.js`);
everything below is about `trove+contrib:`.

## 4. Identity — every package has one, every contribution is addressed under it

A package declares the **domain** it belongs to and its **name** within that domain.
`<domain>/<name>` is the plugin id. There is no anonymous install: a self-chosen opaque
id can be squatted, can't be verified, and can't distinguish "version 2 of this plugin"
from "a different plugin by the same vendor". The domain is proven — the package is
signed, and the domain publishes the signing key at
`https://<domain>/.well-known/trove-assetlinks.json`.

Every contribution is addressed by a URI under its plugin:

```
trove+contrib:<domain>/<plugin>/<contribution>
trove+contrib:acme.com/docs/pdfViewer
```

The host's own contributions use the reserved `core` domain
(`trove+contrib:core/workbench/explorer.delete`), so the address space has exactly one
shape and built-ins are not a special case. The workbench still says
`exec('explorer.delete')`; that's shorthand for the core URI, resolved in one place.

This is what removes cross-kind collisions. A plugin's opener, status slot, register and
command may all be called `status` — they're `.../docs/status` exactly once, because
names are unique *within a plugin*, not within a kind.

## 5. Package format

A plugin is **one module tree**. Indexers and openers are not nested sub-packages —
they're **contributions declared in the manifest**, each naming an entry module inside
that same tree, so everything in a plugin shares modules and code.

```
plugin.zip
  manifest.json                      # identity, capabilities, network endpoints, settings, contributes…
  src/index.js                       # the plugin's own entry (background frame)
  src/shared.js                      # shared by everything below
  src/indexers/pdf.js                # an indexer entry:  export default async (node, ctx) => Contribution
  src/openers/player.js              # an opener entry:   activate(ctx => ctx.onOpen(file => …))
  keymaps/default.json               # a keymap: [{ key, command, when? }, …]
```

`contributes` is **one map of `name -> contribution`**, where each contribution states
its own `type` and that type's options — not a collection per kind. The kinds never
needed separate namespaces; they needed a shared one.

```jsonc
"domain": "acme.com",
"name": "docs",
"displayName": "Acme Docs",
"contributes": {
  "pdfIndex":  { "type": "indexer",    "title": "PDF text & metadata",
                 "match": { "mime": ["application/pdf"], "ext": [".pdf"] },
                 "entry": "src/indexers/pdf.js" },
  "pdfViewer": { "type": "opener",     "title": "PDF Viewer",
                 "match": { "ext": [".pdf"] }, "entry": "src/openers/pdf.js" },
  "export":    { "type": "command",    "title": "Export as…", "offline": true },
  "status":    { "type": "statusItem", "slot": "right", "render": "html" },
  "busy":      { "type": "register",   "default": false },
  "keys":      { "type": "keymap",     "path": "keymaps/default.json" }
}
```

| type | what it is | driven at runtime by |
| --- | --- | --- |
| `command` | a palette command | its handler in the plugin's primary frame |
| `opener` | a viewer for matching files | its `entry` module, in its own frame |
| `indexer` | indexes matching files (server-side) | its `entry` module, in the isolate |
| `statusItem` | a slot in the status bar | `ctx.ui.status(name).set(html)` — sanitized |
| `register` | a context value slot | `ctx.registers.set(name, value)` |
| `keymap` | key bindings from a JSON file | nothing — pure data |

**Registers** are the equivalent of a VS Code context key, but contributed rather than
invented: a when-clause can only gate on a value somebody declared and owns, and it
names it by URI (`"when": "trove+contrib:acme.com/docs/busy"`).

**Keymaps** are read and validated at install. A binding naming one of the plugin's own
commands resolves to that contribution's URI; a binding to anything else must appear in
the manifest's `commands` allowlist, so a shortcut can't be a way around the per-command
grant the user approved.

**Indexers always run on the server.** There is no client-side indexer: indexing is a
property of the drive, not of whoever happens to have a tab open — it must happen once
per upload regardless of which client did it. (The separate `indexer` *capability* is a
different thing: it lets a plugin push its own contributions for a file it's looking at,
through the API.) Openers are the mirror image — they always run in the browser, in
their own sandboxed iframe booted at the opener's entry module.

**The manifest is authoritative.** The host registers exactly what's declared, before
the plugin boots, so what the user approved at install is what the plugin gets — and
contributions exist (and stay listed) even if the plugin's frame never comes up.

An indexer **inherits** from its plugin: the declared `network` endpoint allowlist,
the plugin config + secrets (API tokens), and optionally the plugin's scoped server
storage. It gets **nothing else** — no filesystem, no ambient network, no host globals.

---

## 6. Package storage — two separated concerns

Bulk package **blobs** and install **bookkeeping** have different shapes, sizes, and
ideal backends, so they are separate:

### 4a. Install records → SQLite (the shared provider)

Small, structured, queryable ("list this account's plugins", "which installs register
indexer X", "is `storage` granted for `(account, plugin)`"). Reuse the existing shared
SQLite provider — a dedicated `plugin_installs` table (preferred over KV for the
list/filter queries). One row per `(account, pluginId)`:

```jsonc
{
  "account": "acct_…",
  "pluginId": "com.acme.docs",
  "version": "1.4.0",
  "scope": "account",                // 'device' never reaches the server
  "grantedCaps": ["files","storage","network","indexer"],
  "indexers": ["com.acme.docs.pdf"], // registered server indexers
  "config": { /* non-secret settings */ },
  "secrets": { /* encrypted at rest; API tokens */ },
  "installedBy": "user_…",
  "adminApprovedBy": "user_…|null",
  "packageRef": "acct_…/com.acme.docs/1.4.0.zip",  // key into the PackageStore (§4b)
  "digest": "sha256:…",              // content hash: integrity + cache key + dedupe
  "createdAt": 0, "updatedAt": 0
}
```

### 4b. Package blobs → a pluggable `PackageStore`

The zips are bulk data — users will usually want S3/R2 or a filesystem/NAS for them,
and may want that **independent** of where their file collections live (a dedicated
bucket, or filesystem packages while files are on S3, etc.). So it's a pluggable
provider, mirroring the `StorageBackend` DI already in place:

```js
// core/plugins/packageStore.js
export class PackageStore {
  async put(ref, bytes) {}            // store a package (idempotent by digest)
  async get(ref) {}                   // -> { stream, size } (for download/extract)
  async has(ref) {}                   // -> boolean (cache/dedupe check)
  async delete(ref) {}
  async presignGet(ref, { ttl }) {}   // optional: device downloads straight from storage
}
```

`PackageStore` is essentially a narrow, namespaced `StorageBackend`, so the default
impl just wraps one — `PrefixedStorage(storageBackend, '_plugins/')` — and the same
drivers (`memory` / `filesystem` / `s3`) apply. Config resolves it exactly like the
other backends:

- Default: reuse the **primary storage backend**, prefixed under `_plugins/`.
- Override via `TROVE_PACKAGE_STORE` (+ its own `TROVE_PACKAGE_S3_*` / `TROVE_PACKAGE_FS_ROOT`)
  to point packages at a separate bucket/root — same `{ driver, … }` config shape as
  `TROVE_STORAGE`, resolved through the same `resolve(value, StorageBackend, build)` seam.

It doubles as a **cache**: content-addressed by `digest`, so re-installs/updates dedupe,
devices can be served (or presigned) straight from it, and the isolate runtime extracts
modules from it (with an in-memory/local extract cache in front for hot indexers — an
implementation detail of the runtime, not of the store).

### 4c. Account install flow

1. **Upload** the full package (reuse the upload machinery + `maxUploadBytes` quota).
2. **Re-validate server-side** — re-parse, re-check signature/trust and the capability
   manifest, compute the `digest`. Never trust the client's validation; the server now
   *executes* part of it.
3. **Persist** — `PackageStore.put(ref, bytes)` for the blob (skip if `has(digest)`),
   and the install-record row in SQLite.
4. **Register server components** (§5) and kick off the **backfill** pass.

**Sync:** `GET /api/plugins` returns the account-installed list from SQLite; a device
downloads any package it lacks via the server (or a `PackageStore.presignGet` when the
backend supports it) and enables the client parts locally. Devices are caches; the
server is canonical. Updates = re-upload a new version → re-register → devices re-sync.

**Server-side capability enforcement (the fix):** every `storage` / `indexer` /
`network` call now checks the SQLite install record — "this account installed this
plugin, at this version, with this cap granted" — instead of trusting the client.

---

## 7. IndexerRuntime — running untrusted indexer code with limits

Execution is a **pluggable provider** (same DI pattern as storage / vectorStore /
embeddings / searchTransformer), because no single isolate primitive spans our targets.

```js
// core/indexers/runtime.js
export class IndexerRuntime {
  /**
   * Run one indexer bundle against one file, under hard limits.
   * @param {{ id, modules: Record<string,string>, entry, limits }} bundle
   * @param {IndexRequest} req
   * @returns {Promise<Contribution>}  // { semanticTexts?, tags?, metadata? }
   */
  async run(bundle, req) { throw new Error('unimplemented'); }
}
```

Per-file request/response contract handed into the isolate:

```js
// IndexRequest (what the isolate's default export receives as (file, ctx))
file = { id, name, path, size, contentType }
ctx = {
  readBytes(range?) -> Uint8Array,      // capped ranged read (maxBytes)
  readText() -> string,                 // capped
  presignRead({ ttl }) -> string,       // §6 — a time-limited URL to hand to a remote API
  config, secrets,                      // the plugin's config + API tokens
  fetch(url, init) -> Response,         // BROKERED by the host, confined to declared endpoints
  storage?: { get, set, sql… },         // the plugin's scoped server storage (if granted)
  signal,                               // aborts on the wall-clock limit
}
// returns a Contribution: { semanticTexts?, tags?, metadata? }
```

**Hard limits (host-enforced, not hints):** wall-clock per file, memory, and **output
caps** — max `semanticTexts` count/bytes, max `tags`, max `metadata` size. The
contribution is untrusted data; a hostile or buggy indexer must not be able to blow up
the index or the process. No ambient network; `ctx.fetch` is the host performing the
request against the plugin's endpoint allowlist (same rule as the client `net.fetch`).

**Provider matrix:**

| Target | Impl | Notes |
|---|---|---|
| Node | `isolated-vm` | real isolates, hard mem/CPU caps; native addon (build step) |
| Bun | `worker_threads` / Bun `Worker` | isolate limits differ; acceptable fallback |
| Cloudflare | **dynamic Worker Loader / Sandbox** (chosen) | load the indexer's modules into a fresh isolated sub-worker at index time; no per-install script upload. Verify GA + limits (mem/CPU/module size, outbound fetch). Container Sandbox as the heavier fallback for demanding indexers. |
| CF plain / none | **unsupported** | install-scope check refuses server-indexer plugins on this deployment, with a clear message |

We chose the **dynamic loader/sandbox** route for Cloudflare over Workers-for-Platforms
dispatch namespaces: no pre-upload-per-install step, so the install flow is uniform
across runtimes (all store the package blob the same way; only execution differs), and
the parent Worker never needs `eval`/dynamic `import` — the loader creates a genuinely
separate isolate for the runtime-provided modules.

**Trigger:** registered server indexers join the server `IndexerRegistry`, so
`Vfs.#indexNode` runs them automatically on upload (matched by mime/ext). A **backfill
pass** re-indexes existing matching files when an indexer is installed — concurrency-
and rate-limited, resumable, and it `log()`s anything it skips.

---

## 8. `ctx.file.presignRead()` — a time-limited remote read URL

So an indexer can hand the file to an external service instead of streaming bytes
through itself:

- **S3/R2 collections** → `StorageBackend.presignGet(key, { expiresIn })` — native,
  stateless, expiring.
- **Filesystem/memory (no presign)** → we mint our own signed download URL:
  `/api/fs/download?id=…&exp=<ts>&sig=<hmac>`, an HMAC over `(storageKey, exp, op=read)`
  with a server secret, verified on that route ahead of auth.

Both are **stateless with the expiry baked in** — nothing to clean up, they simply stop
verifying after `exp`. Guardrails: single object, read-only, short default TTL (≤ ~15
min, capped), rate-limited minting.

This also makes many indexers *lightweight orchestrators* (hand off a URL, format the
external API's JSON into a contribution), which lowers the isolate's CPU/memory demand —
relevant to the Cloudflare limits above.

---

## 9. Uninstall teardown

Because the server holds everything, uninstall is a server-owned, ordered sequence:

1. Delete the install-record row (config/secrets) from SQLite and the blob via
   `PackageStore.delete(ref)` — skip the blob delete if another install still
   references the same `digest` (content-addressed dedupe).
2. Drop the scoped server SQLite (`DELETE /api/plugins/:id/data`). Domain-shared scope
   is left intact (shared across the vendor's plugins).
3. For each server indexer: unregister from the `IndexerRegistry`, and **purge its
   contributions from every node** via `removeContributions(node, indexerId)` — the
   reverse of backfill, so removal cleanly un-indexes rather than leaving orphaned
   tags/metadata. (Dynamic-loader CF has nothing to delete — no pre-uploaded script.)
4. Broadcast to connected devices to disable + drop their local copy.

---

## 10. Security summary

- **Authoritative capability enforcement** via the install record (fixes today's
  client-trusted `storage`/index gap).
- **Isolate limits**: wall-clock, memory, and output-size caps per file.
- **Confined network**: `ctx.fetch` brokered against the plugin's declared endpoints; no
  ambient network in the isolate.
- **Presign guardrails**: single-object, read-only, short TTL, rate-limited.
- **Server re-validation** of the uploaded package (signature/trust/caps) — the client's
  validation is never trusted for server-executed code.
- **Admin gate** for anything that runs server code or touches shared resources.

---

## 11. Suggested phasing

1. **Package storage + install records + server-side capability enforcement.**
   ✅ **Implemented** (`packages/core/src/plugins/*`, server routes + wiring):
   pluggable `PackageStore` (default = primary `StorageBackend` prefixed `_plugins/`;
   `TROVE_PACKAGE_STORE` for a separate backend), a `plugin_installs` SQLite table,
   `PluginService` (install / list / download / remove + scope-and-admin gating), and
   `POST /api/plugins/install`, `GET /api/plugins/installed`,
   `GET /api/plugins/:id/package`, `DELETE /api/plugins/:id/install`.
   `assertCapability` enforces grants on `/api/plugins/:id/sql`.

   **Client account-install flow — ✅ implemented:** installing a plugin with a
   server footprint (server `storage` or a server indexer) uploads its full package
   to the server (`api.installPlugin`), `restore()` syncs account plugins the server
   has but this device lacks (download → enable), and uninstall of an account plugin
   cleans up server-side. Device-only plugins stay in IndexedDB. Scope is decided by
   `accountScoped(manifest, grants, files)`.

   *Still transitional:* server enforcement allows a call when no install record
   exists, so plugins installed **before** this change (local-only, never uploaded)
   keep working. Flipping to deny-by-default is safe for fresh deployments; existing
   ones want a one-time **re-upload migration** (on `restore`, push any local
   account plugin the server is missing) first. Server-side **signature/trust**
   re-verification is also still TODO (structure + capabilities are validated today).
2. **IndexerRuntime interface + auto-trigger in `#indexNode` + backfill pass + output
   caps.** ✅ **Implemented** (`packages/core/src/plugins/runtime.js`,
   `packages/core/src/plugins/indexers.js`, `Vfs` pipeline):
   - `IndexerRuntime` base + `InProcessIndexerRuntime` (the **trusted** reference
     runner — imports the entry module from a base64 `data:` URL and calls it under a
     wall-clock timeout). Real isolation (`isolated-vm` / Cloudflare loader) is a
     drop-in subclass; the server picks one via `config.indexerRuntime`, or
     `config.serverIndexers = false` to disable server indexers entirely.
   - `clampContribution()` enforces the **output caps** (max chunks/chars, max tags,
     max metadata bytes; non-scalar tag values dropped) on every runtime's output.
   - `PluginIndexers` coordinator resolves each indexer's bundle from the
     `PackageStore`, registers it into the `Vfs` `IndexerRegistry` (so `#indexNode`
     auto-runs it on upload, matched by ext/mime via `matchFromSelector`), **backfills**
     existing files on install, and **purges** its contributions on uninstall.
   - `PluginService` calls `activate()` on install / `deactivate()` on remove, and
     `init()` re-registers all installed indexers at startup (live hook restored, no
     re-backfill). `#indexNode` refactored into `#indexCtx` + `#runOneIndexer`, with
     `backfillIndexer()` / `purgeIndexer()` paging the metadata store via `listFiles()`.

   *Still a follow-up:* the isolate runtimes (Node `isolated-vm`, Bun worker, CF
   loader) — the in-process runner has **no** isolation and is only safe for
   admin-vetted / first-party code (which the admin install-gate already requires).
3. **`ctx.presignRead()`** — ✅ **S3/R2 native** (`storage.presignGet` when the backend
   advertises `presignDownload`); the self-managed, token-scoped server URL for
   non-presigning backends is still TODO (throws `unsupported` there today).
4. **Cloudflare dynamic-loader/sandbox `IndexerRuntime` impl** (verify GA/limits first).
5. **Install-scope UX**: device vs. account, the admin-approval flow, cross-device sync
   list + download.

## 12. Open questions

- Exact GA status + limits of the Cloudflare dynamic Worker Loader / Sandbox (memory,
  CPU, module size, outbound fetch shape) — gates step 4.
- `isolated-vm` in the default Node/Bun images (native build) vs. a `worker_threads`
  default with `isolated-vm` opt-in.
- Backfill scheduling: on-install full pass vs. lazy re-index on next access vs. both.
- Encryption-at-rest was explicitly deferred; if revisited, presign + SSE interact
  (SSE-C headers must ride the presigned request) — noted, out of scope here.
