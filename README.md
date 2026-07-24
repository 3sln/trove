# 🗄️ Trove

A **self-hostable Google Drive** you actually own — with **semantic search**,
**pluggable storage** (S3 / filesystem / NAS), a **VS Code-style workbench**, and
a **sandboxed plugin system**. Ships as a runtime-agnostic library plus a server
that speaks plain `Request → Response`, so it runs on **Node**, **Bun**, or
**Cloudflare Workers** with a light wrapper.

Built on the [3sln stack](https://github.com/3sln/stack): **ngin** (DI / CQRS),
**dodo** (functional VDOM), **bones** (reactive glue).

```
┌──────────────────────────────────────────────────────────────┐
│  @trove/web            VS Code-style workbench (dodo/ngin/bones)│
│   contributions · commands · keymaps · settings · plugin host  │
├──────────────────────────────────────────────────────────────┤
│  @trove/server         Request → Response  (Node · Worker)     │
├──────────────────────────────────────────────────────────────┤
│  @trove/core     Vfs · Storage · Metadata · Uploads · Search   │
│   S3 / filesystem / NAS   ·   SQLite / memory   ·   embeddings │
└──────────────────────────────────────────────────────────────┘
```

## Highlights

- **Pluggable storage** — S3-compatible (AWS S3, Cloudflare R2, MinIO, B2),
  local filesystem, or a NAS mount. S3 uses **presigned URLs** so large uploads
  and downloads go **straight to the bucket**, never proxied through the server.
  SigV4 is implemented on Web Crypto, so it works on Workers too — no AWS SDK.
- **Resumable large transfers** — multipart uploads with bounded concurrency,
  per-part retry, live progress, and resume-after-drop. Range-aware downloads
  (media seeking, partial fetch).
- **Semantic + keyword search** — a hybrid `SearchService` blends dense vector
  similarity with lexical matching. **Every piece is a pluggable, async provider
  you inject into the server constructor**: the embeddings (offline hash model or
  any OpenAI-compatible endpoint), the **vector store** (in-memory brute-force by
  default, or an external DB — a Qdrant adapter ships in core, and the
  `VectorStore` interface fits pgvector/Pinecone/Milvus/LanceDB), and the keyword
  store. Core hardcodes none of them and stays platform-agnostic.
- **Pluggable indexers** — attach searchable content to files, namespaced under
  the indexer that owns it. A built-in text/code extractor runs server-side;
  plugins push their own documents through the API under their namespace.
- **VS Code-style workbench** — a real contribution system: commands, a command
  palette + quick-open, keybindings (chords, user overrides), when-clauses,
  schema-driven settings, an activity bar, an explorer with drag-and-drop, and
  media openers.
- **Media openers** — text, image, audio, video, and a full **audiobook player**
  for `.m4b`: chapter list, cover art, rich metadata, variable speed, ±30s skip,
  and **resumable progress** — chapters/metadata parsed straight from the MP4
  boxes via HTTP Range reads (opening a 600 MB book is instant).
- **Sandboxed plugins** — plugins are **self-contained ZIP packages** (a
  `manifest.json`, an entry script, and any assets) installed by **URL or file
  upload** — no central catalogue. Each runs in a **hidden, sandboxed iframe on an
  opaque origin** (`allow-scripts`, no `allow-same-origin`): it can't touch the
  host DOM, cookies, or storage, and can't even fetch its own package files. The
  host injects the SDK + the plugin's entry script into the frame and hands it a
  single `MessagePort`; **package resources arrive as opaque byte handles** over
  that port. Everything a plugin can do — file access, storage, UI — is gated by
  the **capabilities the user grants at install time**. A plugin has **no direct network
  access** — the sandbox blocks all egress (`connect-src 'none'`); to reach the
  web it must **declare each endpoint** in its manifest, and the host brokers every
  request, refusing anything off the declared allowlist (including redirects) and
  sending no ambient cookies. Before anything runs, a
  **pre-install review** shows the package's identity, capabilities (each
  explained), contributions, and settings so the user can decide whether to trust
  it. Signed packages show a **domain-verified** badge: the manifest declares a
  domain, and the host checks the signing key's fingerprint against an
  `assetlinks`-style document published at that domain (Digital Asset Links
  style). Plugins get **persistent SQLite storage** — an isolated database per
  scope, both **server-side** (native SQLite via a keyed provider) and **on-device**
  (sql.js/wasm run in the host, persisted to IndexedDB) behind one async SQL
  interface. Scopes are `plugin` (private) and `domain` (shared across a vendor's
  plugins — **verified packages only**); Trove **tracks which plugin owns what
  data** so uninstalling wipes it. They contribute commands, openers, indexers,
  status items, and keybindings, and can surface a popup UI panel. Plugins
  **announce a live capability manifest** on connect (and re-announce when the app
  goes on/offline), each contribution flagged offline-capable or not — so the
  workbench knows which plugin features work right now, disables the ones that
  don't (e.g. a network-only previewer while offline), and treats a plugin that
  sends no manifest as not running. The host also **re-requests the manifest on a
  heartbeat**, so a plugin that hangs or crashes between events is noticed and its
  features are marked unavailable.
- **Conversations on every file** — threaded comments with @mentions, reactions,
  and tags, stored in a **CRDT sidecar document** kept cold in object storage
  (one `sidecars/<id>.json` next to your data — no extra database) and loaded
  into a hot, debounced, merge-on-write manager when active. Indexer facets live
  there too, scoped to the indexer that wrote them.
- **Bring-your-own identity** — Trove ships no login. It verifies an identity JWT
  (Cloudflare Access / Zero Trust, oauth2-proxy, any IdP) via JWKS/RS256/ES256 —
  or a proxy-set header — on Web Crypto, and builds a profile from the claims.
- **Mention notifications over Web Push** — as conversations change, @mentions
  batch per user and flush on an interval as **bodyless VAPID web pushes**; the
  service worker wakes and pulls the inbox. No mention text ever touches a
  third-party push service.
- **Cloudflare-native** — the vector store speaks **Vectorize** (binding or REST),
  storage speaks **R2**, and identity speaks **Access** — first-class, env-driven.
- **Collections** — every item belongs to a collection, which is both a permission
  boundary (read / write / delete / admin grants by user, role, or anyone) and a
  **store config**: each collection points at its own backend (an S3 bucket+prefix,
  a filesystem path, …). Users with the create capability provision new
  collections dynamically by configuring the backing store.
- **Offline mode (PWA)** — a service worker caches the app shell and every
  built-in media player/previewer; "make available offline" pins a file's bytes
  (served from cache) and indexes its text for **offline hybrid search**
  (lexical + local vectors). Comments and tags written offline are **queued and
  merged** (the sidecar is a CRDT) when you reconnect.

## Quick start

```sh
npm install

# 1. Run the API + web app together, in-memory (zero config):
npm run build:web        # builds with Bun
npm run serve            # Bun runtime → http://localhost:8787
#   (npm run serve:node  # same server under Node ≥22.5, if you prefer)

# — or, for development with hot reload —
npm run serve &          # API on :8787
npm run dev              # @web/dev-server on :5173 (unbundled ESM + HMR, proxies /api to :8787)
```

Then open the app, drag files in, and try the command palette (`⌘/Ctrl‑Shift‑P`)
or semantic search (`⌘/Ctrl‑Shift‑F`).

### Configure the backends (env)

```sh
# Storage
TROVE_STORAGE=filesystem            # memory | filesystem | s3
TROVE_FS_ROOT=./data/objects        # for filesystem/NAS (point at a mount)
# …or S3 / R2 / MinIO:
TROVE_STORAGE=s3
TROVE_S3_BUCKET=my-bucket
TROVE_S3_REGION=auto
TROVE_S3_ENDPOINT=https://<acct>.r2.cloudflarestorage.com   # omit for AWS
TROVE_S3_ACCESS_KEY_ID=…            # or AWS_ACCESS_KEY_ID
TROVE_S3_SECRET_ACCESS_KEY=…        # or AWS_SECRET_ACCESS_KEY
TROVE_S3_PATH_STYLE=true            # MinIO / custom endpoints

# Metadata (file tree + facets)
TROVE_METADATA=sqlite               # memory | sqlite
TROVE_DB_PATH=./data/trove.db

# Semantic search embeddings (optional — defaults to an offline local model)
TROVE_EMBEDDINGS_URL=https://api.openai.com/v1/embeddings
TROVE_EMBEDDINGS_API_KEY=sk-…
TROVE_EMBEDDINGS_MODEL=text-embedding-3-small
TROVE_EMBEDDINGS_DIM=1536
```

> **S3 CORS:** for browser-direct presigned uploads/downloads, allow `PUT`/`GET`
> and expose the `ETag` header on your bucket's CORS policy.

## Deploy

**Node / Docker** — `node packages/server/src/adapters/node.js` serves both the
API and the built web app (`packages/web/dist`), with SPA fallback. See
[`Dockerfile`](./Dockerfile).

**Cloudflare Workers** — use `packages/server/src/adapters/worker.js` with R2 (via
the S3 API) for storage and a D1-backed `MetadataStore`. The SigV4 signer and
presigned URLs work unchanged on the Workers runtime.

## Using the core as a library

Every backend is a provider you inject into the server (or `createVfs`) — pass a
class instance, or a `{ driver, ... }` config the server builds for you:

```js
import { createServer } from '@trove/server';
import { S3Storage, SqliteStore, HttpEmbedding, QdrantVectorStore } from '@trove/core';

const { handle } = await createServer({
  storage:     new S3Storage({ bucket, region, accessKeyId, secretAccessKey }),
  metadata:    new SqliteStore({ path: 'trove.db' }),
  embeddings:  new HttpEmbedding({ url, apiKey, model, dimensions: 1536 }),
  vectorStore: new QdrantVectorStore({ url, collection: 'trove', dimensions: 1536 }),
});
```

Bring your own vector DB by implementing the async `VectorStore` interface
(`add` / `remove{,ByNode,ByIndexer,ByNodeIndexer}` / `query`) and passing the
instance in — same for `MetadataStore`, `StorageBackend`, `EmbeddingProvider`,
and `KeywordStore`. Or drive it all from env:

```sh
TROVE_VECTOR=qdrant TROVE_QDRANT_URL=http://localhost:6333 \
TROVE_QDRANT_COLLECTION=trove node packages/server/src/adapters/node.js
```

The lower-level `createVfs` helper does the same wiring for library use:

```js
import { createVfs } from '@trove/core';
const vfs = await createVfs({ storage, metadata, embeddings, vectorStore });
await vfs.writeFile('root', 'note.txt', 'hello');
const hits = await vfs.searchQuery('greeting');
```

## Writing a plugin

A plugin is a **ZIP** containing a `manifest.json`, an entry script, and any
assets. The manifest declares the plugin's id, the capabilities it wants, its
contributions, and its settings:

Capabilities are declared as an object — each key is a capability, each value is
that capability's **options**. A capability that takes no options uses `true` (an
empty object works too); the `network` capability carries its allowed endpoint
prefixes:

```json
{
  "id": "com.example.hello",
  "name": "Hello",
  "version": "1.0.0",
  "entry": "plugin.js",
  "domain": "plugins.example.com",
  "capabilities": {
    "ui": true,
    "commands": true,
    "storage": { "plugin": true, "domain": false },
    "indexer": true,
    "network": { "endpoints": ["https://api.example.com/v1/"] }
  },
  "settings": [{ "key": "apiKey", "type": "string", "title": "API key", "secret": true }]
}
```

A package can be a single entry script (`entry: "plugin.js"`) or **multiple ES
modules**: put your code under `src/` and use ordinary relative imports — no
bundler required. The host loads every `src/*.js` file as a `blob:` module inside
the sandbox and wires them with an import map, so `import './lib/util.js'` and
`import { activate } from 'trove'` both resolve; everything outside `src/` is an
opaque asset you read via `ctx.resources`.

```
my-plugin.zip
├─ manifest.json          # "entry": "src/index.js"
├─ src/index.js           # imports ./lib/http.js, 'trove'
├─ src/lib/http.js
└─ assets/banner.png      # read via ctx.resources, not importable
```

The host injects `@trove/plugin-sdk` into the sandboxed frame; the entry script
calls `trove.activate` (or `import { activate } from 'trove'`):

```js
trove.activate(async (ctx) => {
  // Contribute a command, a status item, an opener, or an indexer.
  ctx.commands.register('hello.world', () => ctx.ui.toast('Hi from a plugin!'));

  // Read a packaged asset via an opaque handle (no URLs leak out of the frame).
  const banner = await ctx.resources.text('banner.txt');

  // Persist state in the plugin's own SQLite db (declare "storage"). Each scope
  // has a `.server` (online) and `.client` (on-device, offline) handle.
  const db = ctx.storage.plugin.server;
  await db.exec('CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT)');
  const row = await db.get('SELECT v FROM state WHERE k = ?', 'count');
  await db.run('INSERT OR REPLACE INTO state VALUES (?, ?)', 'count', String(Number(row?.v || 0) + 1));

  // Read a secret the user entered in settings (never stored in plaintext prefs).
  const key = await ctx.settings.getSecret('apiKey');

  // Reach the web only through the host, and only to declared endpoints ("network").
  const res = await ctx.net.fetch('https://api.example.com/v1/status', {
    headers: { Authorization: `Bearer ${key}` },
  });
  const data = await res.json();

  // Push search documents under this plugin's namespace (declare "indexer").
  ctx.contributes.indexer({ id: 'labels', title: 'Image labels' });
  await ctx.files.index('labels', nodeId, [{ text: 'golden retriever, park' }], { tags: [...] });
});
```

Capabilities the manifest doesn't request (or the user doesn't grant) are simply
absent from `ctx`. To ship a **domain-verified** plugin, sign the package and
publish the key's fingerprint at `https://<domain>/.well-known/trove-assetlinks.json`.
See `packages/web/test/pluginFixture.mjs` for a complete, self-contained example
package.

Inside the sandbox the host injects the SDK and exposes it as the global `trove`.
When you build or bundle your plugin outside the sandbox, `import { activate } from
'@trove/plugin-sdk'` resolves to the **same implementation** — the package entry is
a thin re-export of the injected build, so there's no drift between what you import
and what actually runs.

## Layout

```
packages/
  core/         @trove/core — Vfs, storage/metadata/search backends, uploads (runtime-agnostic)
  server/       @trove/server — Request→Response API + Bun / Node / Worker adapters
  web/          @trove/web — the workbench (dodo + ngin + bones)
  plugin-sdk/   @trove/plugin-sdk — the iframe-side plugin API + RPC
```

## Tests

```sh
bun test                                        # node-level units: core, server, plugin-sdk, mp4, plugin packages/signing
npm run test:browser --prefix packages/web      # web units in real Chromium (@web/test-runner): signing, module graph, zip
node packages/web/test/e2e.mjs                  # full workbench in headless Chromium
node packages/web/test/plugins.e2e.mjs          # sandboxed plugin install, brokered network, offline availability
node packages/web/test/offline.e2e.mjs          # service worker, pinning, offline queue + sync
```

The web unit suites run under **both** `bun test` (fast, via `test/testkit.js`) and
`@web/test-runner` (a real browser, the platform plugins ship to) — the same files,
no duplication.

## License

MIT © Ray Stubbs
