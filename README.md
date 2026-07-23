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
- **Sandboxed plugins** — plugins run in **hidden, sandboxed iframes on their own
  domain** and talk to the workbench only over a `MessagePort`. They contribute
  commands, openers, indexers, status items, and keybindings; they can surface a
  popup UI panel (Chrome-extension style); and — when they declare the capability
  — they get a **persistent per-domain database**.

## Quick start

```sh
npm install

# 1. Run the API + web app together (Node), in-memory (zero config):
npm run build:web
npm run serve            # → http://localhost:8787

# — or, for development with hot reload —
npm run serve &          # API on :8787
npm run dev              # Vite web app on :5173 (proxies /api to :8787)
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

A plugin is a web page on **its own domain** plus a manifest. From inside its
sandboxed iframe it uses `@trove/plugin-sdk`:

```js
import { activate } from '@trove/plugin-sdk';

activate(async (ctx) => {
  // Contribute a command, a status item, an opener, or an indexer.
  ctx.commands.register('hello.world', () => ctx.ui.toast('Hi from a plugin!'));

  // Persist state in this plugin's own database (declare "storage").
  const seen = (await ctx.db.get('count')) || 0;
  await ctx.db.set('count', seen + 1);

  // Push search documents under this plugin's namespace (declare "indexer").
  ctx.contributes.indexer({ id: 'labels', title: 'Image labels' });
  // …and later, when you have labels for a file:
  await ctx.files.index('labels', nodeId, [{ text: 'golden retriever, park' }], { tags: [...] });
});
```

Capabilities the manifest doesn't request (and you don't approve) are simply
absent from `ctx`. See `packages/web/public/plugins/wordcount.html` for a
complete, self-contained example.

## Layout

```
packages/
  core/         @trove/core — Vfs, storage/metadata/search backends, uploads (runtime-agnostic)
  server/       @trove/server — Request→Response API + Node & Worker adapters
  web/          @trove/web — the workbench (dodo + ngin + bones)
  plugin-sdk/   @trove/plugin-sdk — the iframe-side plugin API + RPC
```

## Tests

```sh
bun test                       # core + server + mp4 parser (12 tests)
node packages/web/test/e2e.mjs # full workbench in headless Chromium (9 checks)
```

## License

MIT © Ray Stubbs
