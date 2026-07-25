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
- **Plugin indexers (stub):** a plugin can *declare* an indexer client-side
  (`ctx.contributes.indexer`), but the `indexer:run` path has **no caller** — nothing
  triggers it. The only way contributions land is a manual `ctx.files.index(...)` from
  a browser. There is **no server-side plugin execution and no automatic pipeline.**
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

## 3. Package format

The plugin package (zip) may embed **indexer sub-packages** — each a self-contained ESM
bundle with its own entry + manifest — under a conventional directory:

```
plugin.zip
  manifest.json                      # plugin manifest (capabilities, network endpoints, settings…)
  src/… | plugin.js                  # client code (iframe), as today
  indexers/
    <indexer-id>/
      manifest.json                  # indexer manifest (below)
      index.js                       # ESM entry: export default async (file, ctx) => Contribution
      lib/…                          # sibling ESM modules
```

Indexer manifest:

```jsonc
{
  "id": "com.acme.pdf",              // namespaced under the plugin id at registration
  "displayName": "PDF text & metadata",
  "match": { "mime": ["application/pdf"], "ext": [".pdf"] },
  "entry": "index.js",
  "offline": false,                  // needs network? (affects availability, batch scheduling)
  "limits": { "maxMillis": 5000, "maxMemoryMb": 128 }   // hints; host enforces a ceiling
}
```

An indexer **inherits** from its plugin: the declared `network` endpoint allowlist,
the plugin config + secrets (API tokens), and optionally the plugin's scoped server
storage. It gets **nothing else** — no filesystem, no ambient network, no host globals.

---

## 4. Package storage — two separated concerns

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

## 5. IndexerRuntime — running untrusted indexer code with limits

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

## 6. `ctx.file.presignRead()` — a time-limited remote read URL

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

## 7. Uninstall teardown

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

## 8. Security summary

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

## 9. Suggested phasing

1. **Package storage + install records + server-side capability enforcement.**
   ✅ **Implemented** (`packages/core/src/plugins/*`, server routes + wiring):
   pluggable `PackageStore` (default = primary `StorageBackend` prefixed `_plugins/`;
   `TROVE_PACKAGE_STORE` for a separate backend), a `plugin_installs` SQLite table,
   `PluginService` (install / list / download / remove + scope-and-admin gating), and
   `POST /api/plugins/install`, `GET /api/plugins/installed`,
   `GET /api/plugins/:id/package`, `DELETE /api/plugins/:id/install`.
   `assertCapability` enforces grants on `/api/plugins/:id/sql`.
   *Transitional:* enforcement allows a call when no server install record exists
   (device plugins predate this) — it flips to deny-by-default once the client
   account-install flow (uploads packages to the server) lands. Server-side
   **signature/trust** re-verification is still TODO (structure + capabilities are
   validated today).
2. **IndexerRuntime interface + Node (`isolated-vm`) impl + auto-trigger in `#indexNode`
   + backfill pass + output caps.**
3. **`ctx.file.presignRead()`** (S3 native + self-signed URL).
4. **Cloudflare dynamic-loader/sandbox `IndexerRuntime` impl** (verify GA/limits first).
5. **Install-scope UX**: device vs. account, the admin-approval flow, cross-device sync
   list + download.

## 10. Open questions

- Exact GA status + limits of the Cloudflare dynamic Worker Loader / Sandbox (memory,
  CPU, module size, outbound fetch shape) — gates step 4.
- `isolated-vm` in the default Node/Bun images (native build) vs. a `worker_threads`
  default with `isolated-vm` opt-in.
- Backfill scheduling: on-install full pass vs. lazy re-index on next access vs. both.
- Encryption-at-rest was explicitly deferred; if revisited, presign + SSE interact
  (SSE-C headers must ride the presigned request) — noted, out of scope here.
