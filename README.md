# 🗄️ Trove

A **self-hostable Google Drive** you actually own — with **semantic search**,
**pluggable storage** (S3 / filesystem / NAS), a **search-first workbench**, and
a **sandboxed plugin system**. Ships as a runtime-agnostic library plus a server
that speaks plain `Request → Response`, so it runs on **Node**, **Bun**, or
**Cloudflare Workers** with a light wrapper.

Built on the [3sln stack](https://github.com/3sln/stack): **ngin** (DI / CQRS),
**dodo** (functional VDOM), **bones** (reactive glue).

```
┌──────────────────────────────────────────────────────────────┐
│  @trove/web         search-first workbench (dodo/ngin/bones)   │
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
- **No folders** — a collection is a **flat set of uniquely-named items**. You find
  things by searching, and you group them by **linking**: any item is addressable as
  `trove:<collection>?name=…` (or `?id=…`), so a markdown document that links its
  sources does what a folder did — except it can say *why* those things belong
  together, an item can appear in as many documents as you like, and the grouping is
  searchable content rather than an invisible box. A links indexer records those
  references, so every item shows **what links to it**.
- **Search-first workbench** — the main panel is a launcher (Spotlight/Raycast
  style): type to search files, `!` to run a command, `#tag` / `#key:>=value` to
  filter by tag or property; recents and the collection sit underneath. Opening
  a file shows the opener **beside** the launcher (split) or **over** it (modal) —
  your last choice is the default, and you can swap. Underneath is a real
  contribution system: commands, a command palette + quick-open, keybindings
  (chords, user overrides), when-clauses, schema-driven settings, and media openers.
- **Media openers** — markdown (with live `trove:` links), text, image, audio,
  video, and a full **audiobook player**
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
  or a proxy-set header — on Web Crypto, and builds a profile from the claims. You
  can also name the keys you trust directly (`TROVE_JWT_JWKS`), so a deployment that
  mints its own tokens needs no JWKS endpoint. With no identity configured at all
  there is one shared anonymous user and **no profile is shown** — an avatar for
  somebody who doesn't exist implies an account there is no way to sign in to.
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

The server is one function — `handle(Request) -> Promise<Response>` — so an adapter is
thin and there is no runtime-specific code below it. Pick a row:

| runtime | storage | metadata + search | notes |
| --- | --- | --- | --- |
| **Bun** | filesystem / S3 | SQLite file | recommended for self-hosting |
| **Node** | filesystem / S3 | SQLite file | identical behaviour, a little slower |
| **Workers** | R2 (S3 API) | D1 + Vectorize | no local disk, so both must be bound |

### Bun (recommended)

```sh
bun install
bun run build:web                       # builds packages/web/dist
TROVE_STORAGE=filesystem TROVE_FS_ROOT=./data/objects \
TROVE_METADATA=sqlite TROVE_DB_PATH=./data/trove.db \
bun packages/server/src/adapters/bun.js  # :8787, API + web app
```

That is the whole thing: object bytes under `$TROVE_FS_ROOT/objects/` (the backend
creates that subdirectory, sharded two levels deep), everything else in one SQLite file. Back it up with `npm run backup` (a `VACUUM INTO` snapshot, safe on a live
database) and copy the objects directory.

### Node

Identical, with `node`:

```sh
TROVE_STORAGE=filesystem TROVE_FS_ROOT=./data/objects \
TROVE_METADATA=sqlite TROVE_DB_PATH=./data/trove.db \
node packages/server/src/adapters/node.js
```

Node 20+ for `node:sqlite`. Both adapters serve the built web app with SPA fallback and
trap `SIGTERM`/`SIGINT` to shut down cleanly — flush notifications, stop an in-flight
reindex, close SQLite — so a redeploy doesn't lose work. See [`Dockerfile`](./Dockerfile).

### Cloudflare Workers

There is no disk, so the two things a self-hosted run keeps in a file need bindings:

```toml
# wrangler.toml
main = "packages/server/src/adapters/worker.js"
compatibility_date = "2024-09-23"

[[d1_databases]]                 # metadata, KV, plugin installs, keyword search
binding = "DB"
database_name = "trove"
database_id = "..."

[[vectorize]]                    # semantic search (sqlite-vec cannot run here)
binding = "VECTORIZE"
index_name = "trove"

[ai]                             # optional: LLM query understanding
binding = "AI"

[assets]                         # the built web app
directory = "packages/web/dist"
binding = "ASSETS"

[vars]
TROVE_STORAGE = "s3"             # R2 through the S3 API
TROVE_S3_BUCKET = "trove"
TROVE_S3_REGION = "auto"
TROVE_S3_ENDPOINT = "https://<account>.r2.cloudflarestorage.com"
TROVE_AUTH = "cloudflare-access"
TROVE_CF_ACCESS_TEAM = "acme"
TROVE_CF_ACCESS_AUD = "<aud-tag>"
TROVE_ADMINS = "you@example.com"  # see "Making yourself an admin" below
TROVE_DEFAULT_OPEN = "false"      # otherwise every Access user gets the default collection
```

```sh
wrangler secret put TROVE_S3_ACCESS_KEY_ID
wrangler secret put TROVE_S3_SECRET_ACCESS_KEY
wrangler d1 execute trove --command "SELECT 1"   # create it first
wrangler deploy
```

The adapter wires `DB` through `D1SqliteProvider` and `VECTORIZE` through
`VectorizeVectorStore` on its own. **Bind `DB` or the drive runs entirely in memory** —
which works right up until the isolate is recycled and everything is gone. R2 works
through the S3 API rather than the R2 binding because that is what makes presigned
uploads go straight to the bucket instead of through your Worker's CPU time.

Two Workers-specific limits worth knowing before you commit: `sqlite-vec` is a native
artifact and cannot load, so semantic search *needs* Vectorize; and plugin scopes each
want their own D1 database, since D1 cannot create one on demand and co-locating them
would put a plugin's tables next to the drive's metadata. Bind `PLUGIN_DB` if you use
server-side plugin storage — without it, that one feature reports a clear error and the
rest of the drive is unaffected. One D1 database holds every plugin scope: D1 cannot
create databases on demand and a scope key contains the user's id, so per-scope
databases are not expressible here. Their tables sit side by side, which is weaker
isolation than the file-per-scope a self-hosted run gets.

### Making yourself an admin

An admin can install plugins that ship server code, create collections, and rebuild the
search index — the operations that are drive-wide rather than per-collection.

```toml
[vars]
TROVE_ADMINS = "you@example.com,ops@example.com"
```

The list is matched against each request's principal **by email or by id**, so the
address you sign in to Access with is the thing to write down. This matters more than it
sounds: Cloudflare Access puts an internal user UUID in the token's `sub` claim, which
is what becomes `principal.id` — so an admin list of ids would mean pasting
`8f2a1c04-6d3e-…` and having no way to find it short of decoding a JWT.

Check it worked. `admin` is the whole answer:

```sh
curl -s https://drive.example.com/api/me | jq
# { "principal": { "id": "8f2a1c04-…", "email": "you@example.com", … },
#   "authenticated": true, "admin": true }
```

`authenticated: false` means Access isn't reaching the origin — the Worker is being
called directly, or the Access application doesn't cover this hostname. `admin: false`
with the right email means the address in `TROVE_ADMINS` doesn't match the one in the
token; `/api/me` shows you both.

Two things worth doing at the same time:

- **`TROVE_DEFAULT_OPEN=false`.** The default collection is open to anyone who reaches
  it, which is right for a single-user drive and wrong the moment Access lets a team in.
  With it off, access comes only from an explicit grant — and the admin list is one.
- **Share by email too.** A per-collection grant (`{ type: "user", subject: … }`) matches
  the same way, so an ACL written by a human names people the way humans do.

The whole Access setup, including what to put in the Zero Trust dashboard, is in
[Cloudflare Access (Zero Trust)](#cloudflare-access-zero-trust).

### Every setting

Defaults are what you get with the variable unset. Everything here is read once at
startup by `configFromEnv` (`packages/server/src/index.js`), so a library caller can pass
the same values as config fields instead.

| variable | default | what it does |
| --- | --- | --- |
| **storage** | | |
| `TROVE_STORAGE` | `memory` | `memory` · `filesystem` · `s3` |
| `TROVE_FS_ROOT` | `./data/objects` | filesystem root; bytes go in `<root>/objects/` |
| `TROVE_S3_BUCKET` / `_REGION` / `_ENDPOINT` | — | S3/R2/MinIO; endpoint for non-AWS |
| `TROVE_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | — | credentials (use secrets, not env files) |
| `TROVE_S3_PATH_STYLE` | `false` | MinIO and most S3-compatibles need `true` |
| `TROVE_MAX_UPLOAD_BYTES` | unlimited | per-file ceiling; over it is `413`, not `507` |
| **metadata + search** | | |
| `TROVE_METADATA` | `sqlite` unless storage is memory | `memory` · `sqlite` |
| `TROVE_DB_PATH` | `./data/trove.db` | the one file holding metadata, KV, and installs |
| `TROVE_VECTOR` | follows durability | `sqlite` · `memory` · `qdrant` · `vectorize` |
| `TROVE_KEYWORD` | follows durability | `sqlite` · `memory` |
| `TROVE_EMBEDDINGS_URL` / `_KEY` / `_MODEL` / `_DIM` | offline hash model | any OpenAI-compatible endpoint |
| `TROVE_SEARCH_TRANSFORMER` | `parse` | `parse` · `workers-ai` (query understanding) |
| `TROVE_REBUILD_INDEX_ON_START` | `true` | rebuild when the index is empty and the drive isn't |
| **identity** | | |
| `TROVE_AUTH` | `anonymous` | `anonymous` · `cloudflare-access` · `jwt` · `header` |
| `TROVE_AUTH_REQUIRED` | `false` | **set this** — else unauthenticated is anonymous |
| `TROVE_CF_ACCESS_TEAM` / `_AUD` | — | Cloudflare Access, derives everything else |
| `TROVE_JWKS_URL` / `TROVE_JWT_JWKS` / `_JWKS_FILE` | — | keys to trust: fetched, inline, or a file |
| `TROVE_JWT_ISSUER` / `_AUDIENCE` / `_ALGS` | — | claim checks after the signature passes |
| `TROVE_AUTH_SERVER` | the JWT issuer | where refused clients are sent to sign in |
| `TROVE_ADMINS` | — | comma-separated ids with whole-drive rights |
| **collections** | | |
| `TROVE_COLLECTIONS` | on | `false` for one open store with no ACLs |
| `TROVE_DEFAULT_OPEN` | `true` | **set `false`** before exposing it |
| `TROVE_COLLECTION_CREATOR_ROLES` | — | roles allowed to create collections |
| **agents** | | |
| `TROVE_MCP` | on | `off` disables the endpoint |
| `TROVE_MCP_PATH` / `_RESOURCE` / `_REQUIRE_AUTH` | `/mcp` | see [Connecting an AI agent](#connecting-an-ai-agent-mcp) |
| **housekeeping** | | |
| `TROVE_TRASH_DAYS` | `30` | `0` keeps the trash forever |
| `TROVE_SCAN_INTERVAL_MS` | off | reconcile with the store on a timer |
| `TROVE_MAINTENANCE_INTERVAL_MS` | `300000` | sweep stale uploads and sidecars |
| `TROVE_MENTION_FLUSH_MS` | — | how often mention notifications batch out |
| `TROVE_VAPID_PUBLIC_KEY` / `_PRIVATE_KEY` / `_SUBJECT` | — | Web Push for @mentions |
| **limits + serving** | | |
| `TROVE_MAX_JSON_BYTES` | `4 MiB` | JSON body cap (uploads stream, so bound those at the proxy) |
| `TROVE_MAX_PAGE` | `1000` | ceiling on any client-supplied `limit` |
| `TROVE_PORT` / `TROVE_HOST` | `8787` / `0.0.0.0` | |
| `TROVE_WEB_DIST` | `packages/web/dist` | built web app to serve |
| `TROVE_CORS_ORIGIN` | off | `*` or an allowlist; the app is same-origin (MCP follows it too) |
| `TROVE_PUBLIC_URL` | detected | the drive's public origin, for sign-in discovery |
| `TROVE_TRUST_PROXY` | `false` | honour `X-Forwarded-Proto/Host` — only behind a real proxy |
| `TROVE_CSP` | off | opt-in shell CSP (see `SAMPLE_CSP`) |
| **plugins** | | |
| `TROVE_SERVER_INDEXERS` | on | `false` disables server-side plugin indexers |
| `TROVE_ENFORCE_PLUGIN_CAPS` | `false` | strict capability enforcement |
| `TROVE_PACKAGE_STORE` / `TROVE_PACKAGE_FS_ROOT` | primary storage | where plugin zips live |

### Before you expose it

Trove ships **no login**, and a zero-config run is **open to anyone who can reach
the port** (anonymous auth + an open default collection — you'll see a startup
warning). Before putting it on a network:

- **Authenticate.** Set `TROVE_AUTH=jwt` (verify a JWT via `TROVE_JWKS_URL`, e.g.
  Cloudflare Access) or `TROVE_AUTH=header` (trust a header a verifying proxy
  set), plus `TROVE_AUTH_REQUIRED=true` so unauthenticated requests are rejected
  rather than treated as anonymous. Consider `TROVE_DEFAULT_OPEN=false` and
  `TROVE_ADMINS=…`.
- **Terminate TLS at a reverse proxy** (Caddy, nginx, Traefik, Cloudflare) — the
  server itself speaks plaintext on `0.0.0.0:8787`. Front it with the proxy and
  don't publish the port directly. Also cap the proxy's max request body size —
  the server caps JSON bodies (`TROVE_MAX_JSON_BYTES`) but streams file-upload
  parts straight to storage, so bound raw upload size at the proxy (and/or set
  disk/bucket quotas) to prevent a write-capable user from filling the store.
- **Set `TROVE_PUBLIC_URL`** to the address people actually reach the drive at. It is
  what the sign-in challenge and the agent discovery document advertise. Trove will
  otherwise read it off the request, and `X-Forwarded-Host` is set by whoever is talking
  to it — so that header is honoured only with `TROVE_TRUST_PROXY=true`, which is safe
  exactly when a proxy is guaranteed to be in front.
- **CORS stays off** unless you set `TROVE_CORS_ORIGIN` (the app is same-origin).
  A shell **CSP** is opt-in via `TROVE_CSP` (see `SAMPLE_CSP`); it's off by
  default because sandboxed plugin iframes can't satisfy a strict one. The API
  still forces attachment downloads + `nosniff` to neutralize uploaded HTML/SVG.
- **Cross-site writes are refused**, independently of CORS. An allowlist only decides
  who may *read* a reply, and only for requests a browser preflights — a `POST` with
  `content-type: text/plain` is a CORS *simple* request, so it is sent without one and
  the deletion happens whether or not anyone can read the answer. So every
  state-changing request (JSON API and MCP alike) is checked against `Sec-Fetch-Site`
  and `Origin`, and a cross-site one gets a 403. Non-browser clients — curl, an agent,
  a script — send neither header and are unaffected; they carry no ambient credential
  for another site to borrow, which is the whole basis of the attack. Setting
  `TROVE_CORS_ORIGIN` to a specific origin permits that origin to write, too.

### Naming the keys you trust

Three ways to say who a request is from, in the order most deployments reach for
them:

```sh
# 1. A proxy already authenticated the user and set a header (Cloudflare Access,
#    oauth2-proxy). The browser sends nothing; Trove trusts the header.
TROVE_AUTH=header TROVE_AUTH_ID_HEADER=cf-access-authenticated-user-email

# 2. Cloudflare Access / Zero Trust — the team name is the only thing that isn't
#    derivable. TROVE_CF_ACCESS_AUD is the Access *application's* AUD tag: without it,
#    a token minted for any other app in the same Access account verifies here too.
TROVE_AUTH=cloudflare-access TROVE_CF_ACCESS_TEAM=acme TROVE_CF_ACCESS_AUD=<aud-tag>

# 3. Any other IdP that publishes a JWKS you fetch.
TROVE_AUTH=jwt TROVE_JWKS_URL=https://issuer.example.com/.well-known/jwks.json \
TROVE_JWT_ISSUER=https://issuer.example.com TROVE_JWT_AUDIENCE=trove

# 4. You mint your own tokens, so there is no JWKS endpoint to point at — name the
#    keys directly. Inline JSON, or a file (which keeps a multi-line document out of
#    the environment and out of `docker inspect`).
TROVE_AUTH=jwt TROVE_JWT_JWKS_FILE=/run/secrets/trove-jwks.json \
TROVE_JWT_ISSUER=https://you.example TROVE_JWT_AUDIENCE=trove
```

**What is trusting what.** The signature is verified against the key material, and
nothing else: `TROVE_JWT_JWKS` is a key set you hold (nothing is fetched, so there is
nothing to spoof), `TROVE_JWKS_URL` is one Trove fetches over HTTPS (so the authenticity
of those keys rests on that host's TLS certificate), and `TROVE_JWT_SECRET` is a shared
HS256 secret. The key is chosen by the token's `kid`.

`TROVE_JWT_ISSUER` and `TROVE_JWT_AUDIENCE` are **claim checks**, not trust anchors — a
string comparison against `iss` and `aud` after the signature has already passed. They
cost nothing and are worth setting: they stop a token that is validly signed by a key you
trust but was minted for a different issuer or a different application, which is a real
case when a JWKS serves several or the IdP is multi-tenant. On their own they secure
nothing, since anyone forging a token also sets those claims.

Always add `TROVE_AUTH_REQUIRED=true` so an unauthenticated request is rejected
rather than treated as anonymous. `TROVE_JWT_ALGS` narrows the accepted algorithms
(the default is inferred from the key material: `HS256` for a secret, `RS256`/`ES256`
for a key set). A key set with more than one key requires a `kid` on the token —
trying each key until one verifies would turn key rotation into key confusion.

The **web client** presents a bearer token from `localStorage['trove.token']` when
one is present. It isn't needed for the proxy-authenticated case (the browser's
existing session covers it), and note that with a bearer token, downloads are
fetched and handed to the browser as a blob rather than streamed — an `<a href>`
can't carry an Authorization header, and putting the token in the URL would leak it
into logs and history.

### Running out of room

A filesystem or NAS collection reports how much space is left — a gauge in the status
bar, amber under 10% free and red under 5%. An S3 collection shows nothing at all,
because an object store has no such number and a made-up meter is worse than none.

When the disk does fill, the failure is specific rather than generic: **507
Insufficient Storage**, not retryable, with a message that says what happened. (429
would tell the client to back off and try again — which against a full disk is an
infinite loop, since only a human can clear it.) The condition is also recorded as a
standing issue, so the person who needs to fix it hears about it even if they weren't
the one whose upload failed. Reads, search and downloads keep working throughout.

### Deleting

Deleting moves an item to the **trash**: it leaves the drive — gone from listings,
search, name lookups and backlinks — but the bytes stay exactly where they are and
the record keeps its id. A confirm dialog is not a safety net; it is a thing people
click through, and on a drive holding your only copy of something that matters.

```
POST /api/items/delete       → trash it (recoverable)
GET  /api/trash              → what's in there
POST /api/trash/restore      → put it back, re-indexed
POST /api/trash/purge        → destroy one item, or empty the trash
```

Restoring re-indexes the item, so it is findable again rather than merely visible.
If its name was taken while it was away, it comes back under a free one — someone
restoring a file wants the file, not an error about a name.

`TROVE_TRASH_DAYS` (default 30) is how long an item stays recoverable; `0` keeps
the trash forever. That timer is the only thing in Trove that destroys data
without someone asking, which is why it is a number you set rather than a default
buried in code.

### Data & backups

State lives in two places, both configurable and mounted as a volume in the
Dockerfile (`/data`):

- **Objects** — `TROVE_FS_ROOT` (filesystem) or your S3/R2 bucket.
- **Metadata + KV** — the SQLite file at `TROVE_DB_PATH` (WAL mode).
- **The search index** — the same SQLite file: vectors via `sqlite-vec`, keywords
  via FTS5. It is derived state, so it is not something you *have* to back up —
  if it is missing on startup and the drive is not, Trove rebuilds it in the
  background and says so in the log.

To back up the database safely while Trove is running:

```sh
bun scripts/backup.mjs ./data/trove.db ./backups/trove-$(date +%F).db
```

**Do not just copy the file.** In WAL mode the database is three files (`.db`,
`-wal`, `-shm`) and your most recent writes live in the `-wal`; copying the `.db`
alone produces a backup that opens cleanly and is silently missing them — the
worst kind, because it looks like a backup. The script uses SQLite's `VACUUM
INTO`, which is an online backup that takes a read lock rather than blocking
writers, and it refuses to overwrite an existing file.

(The usual advice, `sqlite3 db ".backup out.db"`, works too — but the `sqlite3`
CLI is not in the image Trove ships, so inside the container it just fails.)

Back up the object store separately with your storage's native tooling (`rsync`
the filesystem root, or bucket replication/versioning for S3/R2) — the database
holds metadata and the search index, not your bytes.

Restoring is putting both back and starting up: verified end to end on a
3,005-item drive — same item count, same byte total, search intact, files
downloadable. And if the search index is ever lost on its own, Trove notices at
startup and rebuilds it. `/api/health` is a liveness check; `/api/ready` probes
the store for readiness gating.

## Background work and standing problems

Two registries, split by **lifetime** — the distinction is the design, not an
implementation detail:

| | Tasks | Issues |
|---|---|---|
| What | work in flight | a problem that outlived the work |
| Where | in memory, per process | the KV store, durable |
| Ends when | the work ends | the underlying thing actually succeeds |
| API | `GET /api/tasks` | `GET /api/issues` |

A task that was running when the server stopped is *not* running — forgetting it is
correct. But a file that failed to index is still unindexed tomorrow, so that has to
survive a restart. They meet at the retry: **a failure raises an issue, retrying it
starts a task, and the task succeeding clears the issue.** Nothing is cleared by being
acknowledged.

The client shows one list covering both sides of the wire — an upload running in the
browser and a reindex running on the server appear together, because a user doesn't
care which machine is busy. Server tasks are a read-only mirror; the browser never
drives them. Progress is determinate (`done`/`total`/`unit`) or explicitly
indeterminate: a caller that doesn't know the total leaves it `null` and gets a
spinner, rather than a progress bar that guesses.

Transport is adaptive polling — 1 s while something is running, a minute when idle.
There's no streaming transport in the server yet, and SSE through three runtime
adapters isn't worth it to move a progress bar; only the poll would change if one
ever exists.

### Picking up changes made outside Trove

Trove is not the only thing that can write to your bucket. Another tool, a teammate
with the S3 console, a sync client, a lifecycle rule — any of them leaves the drive
describing a world that no longer exists, and with no folders, "it isn't in the list"
is indistinguishable from "it was never there".

A **collection scan** reconciles the two, naming the four things an object can be:

| | |
|---|---|
| known & unchanged | nothing to do |
| in the store only | **adopted** — an item is created, named from its key |
| changed in place | **refreshed** — re-read and re-indexed |
| in metadata only | **orphaned** — reported, *never* deleted automatically |

That last asymmetry is deliberate. Adopting a file is additive and reversible;
removing an item because a LIST call didn't mention it is neither — and listing is
exactly the operation that fails in interesting ways (a wrong prefix, a stale
replica, a credential scoped elsewhere). Trove will invent an item from bytes it can
see. It will not destroy a record because it briefly couldn't see any.

```sh
curl -X POST http://localhost:8787/api/collections/default/scan
# or "Scan Collection for Outside Changes" in the palette
```

Set `TROVE_SCAN_INTERVAL_MS` to scan on a timer. Off by default: a scan lists every
object in the bucket, which costs API calls on S3 and load on a NAS. Turn it on when
something other than Trove writes to the same bucket.

### Reindexing

Indexing runs when an item is written (`writeFile`) or when an upload completes
(`POST /api/uploads/:id/complete`) — including uploads that went straight to S3, since
the *complete* call is the trigger. Objects written directly into the bucket behind
Trove's back are invisible: Trove owns its key namespace, and there's no bucket scan.

A full rebuild happens automatically when the index is empty and the drive is not, and
on demand:

```sh
curl -X POST http://localhost:8787/api/reindex     # or: "Rebuild Search Index" in the palette
```

It returns a task rather than blocking. Drive-wide, so it requires either a
`TROVE_ADMINS` admin or someone who can already read and write every collection —
which the default single-user self-host is.

## Where clients sign in

Trove does not run a login system. It verifies tokens somebody else issued, which leaves
one question every refused request has to answer: *where do I go and get one?* A bare 401
is a dead end for a browser and an absolute dead end for an agent, which has no human to
ask.

So the drive publishes it, once, for everything:

```sh
TROVE_AUTH_SERVER=https://auth.example.com
```

Every 401 — from the JSON API, from the MCP endpoint — then carries a pointer:

```
WWW-Authenticate: Bearer realm="Trove", error="invalid_token",
  error_description="...",
  resource_metadata="https://drive.example.com/.well-known/oauth-protected-resource"
```

and that document ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html)) names the
authorization server. It is the same mechanism the MCP authorization spec is built on,
which is why implementing it once serves both a browser and an agent.

**You often don't have to set it.** For an OIDC provider the issuer identifier *is* the
authorization server — that is what RFC 8414 locates its metadata relative to — so when
`TROVE_JWT_ISSUER` is a URL, Trove uses it. Set `TROVE_AUTH_SERVER` when they genuinely
differ. Asking for the same URL under two names is a good way to end up with two
different answers.

The inference only fires when the issuer is an `https` URL (or `http` on loopback). A
JWT `iss` is `StringOrURI`, so a deployment minting its own tokens may well have set it
to `my-gateway` or a URN — publishing one of those as an authorization server would send
clients off to fetch `.well-known` from a string, which fails less usefully than
publishing nothing. In that case Trove publishes nothing and says why, at boot.

Not setting either is the failure that looks like success: auth is required, and there is
nowhere to send anyone. Trove says so in the challenge itself and in Settings, rather
than leaving you to infer it from an empty field.

It is deployment configuration, not a preference — pointing the drive at a different
authorization server changes who can reach every file in it — so it comes from the
environment, or from the library caller:

```js
const { handle } = await createServer({
  authServer: 'https://auth.example.com',
  identity: { driver: 'jwt', jwt: { jwksUrl: '...', audience: '...' } },
});
```

### Cloudflare Access (Zero Trust)

Two env vars, and both the browser and agents are covered:

```sh
TROVE_AUTH=cloudflare-access
TROVE_CF_ACCESS_TEAM=acme          # or acme.cloudflareaccess.com
TROVE_CF_ACCESS_AUD=<aud-tag>      # the Access application's AUD
```

That derives the JWKS URL, the issuer, and the authorization server — they are all the
same team domain, and writing it into three settings is three chances to have them
disagree. A domain that isn't `*.cloudflareaccess.com` is refused rather than accepted,
since it would send both token verification and agent sign-in somewhere unintended.

**For agents, turn on [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
on the Access application.** Access then acts as the OAuth authorization server itself —
including dynamic client registration, which the MCP spec expects and which a plain
Access SaaS/OIDC app does not do. Without it, an agent hitting `/mcp` gets Access's HTML
login page, which it cannot do anything with.

With managed OAuth on, Access answers the 401 at the edge, so **Trove's own challenge is
never reached** — that is fine and intended, and it is why Trove doesn't need to be
configured differently for it. What arrives at the origin is the resolved
`Cf-Access-Jwt-Assertion`, which Trove verifies exactly as it does a browser's.

One subtlety worth knowing, because it is invisible when it goes wrong: the agent's token
under managed OAuth is **opaque**, not a JWT, and it travels in `Authorization: Bearer`.
The real signed JWT is the assertion header. Trove reads the assertion header *first* for
that reason — and because it is the one the edge vouched for, rather than the one the
caller typed.

#### Who your users are, to Trove

Access mints a token whose `sub` is an **internal user UUID**, not an address. That UUID
becomes `principal.id`; the address lands in the `email` claim. So anywhere you write a
person down — `TROVE_ADMINS`, a collection's `user` grant — **either works**, and the
email is the one to reach for.

```sh
curl -s https://drive.example.com/api/me | jq
# { "principal": { "id": "8f2a1c04-…",     # Access user UUID  (the `sub` claim)
#                  "email": "you@example.com",
#                  "roles": [] },
#   "authenticated": true, "admin": true }
```

`roles` comes from a `roles` or `groups` claim. Access does not send one by default —
add it to the application's OIDC claims if you want `TROVE_COLLECTION_CREATOR_ROLES` or
role-based grants to have anything to match.

## Connecting an AI agent (MCP)

Trove speaks the [Model Context Protocol](https://modelcontextprotocol.io) at `/mcp`.
Point an assistant at that URL and it can search the drive, read and write files, and
follow the `trove:` links between them. The tools go through the same permission checks
the web app does, so an agent sees exactly what the person whose token it holds sees —
there is no service account and no MCP-shaped path around the collection ACL.

```sh
# What to paste into an assistant, and whether it needs a token:
curl http://localhost:8787/api/capabilities | jq '.mcp, .auth'
```

On an open drive (the zero-config default) an agent just connects. Demanding a bearer
token from an agent for a drive that demands none from a browser would protect nothing.

### Authentication

When the drive has a real identity provider, MCP requires the **same JWT** the browser
presents. An agent that hasn't got one discovers where to get it, per
[RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html), which is what the MCP
authorization spec builds on:

```
$ curl -i -X POST http://localhost:8787/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="Trove", error="invalid_token",
  error_description="...",
  resource_metadata="http://localhost:8787/.well-known/oauth-protected-resource/mcp"

$ curl http://localhost:8787/.well-known/oauth-protected-resource/mcp
{"resource":"http://localhost:8787/mcp",
 "authorization_servers":["https://auth.example.com"],
 "scopes_supported":["trove:read","trove:write"],
 "bearer_methods_supported":["header"]}
```

The client reads that, runs the OAuth flow at your authorization server, and comes back
with a token. Trove never runs the login itself — it verifies what your IdP issued.

**This is the drive's authorization server, not MCP's.** "Where do I sign in" is a
property of the deployment, so a 401 from `/api/items` carries the same challenge, and
`/.well-known/oauth-protected-resource` describes the drive itself. One setting, two
surfaces, no way for them to disagree — see [Where clients sign in](#where-clients-sign-in).

| variable | what it does |
| --- | --- |
| `TROVE_MCP` | `off` to disable the endpoint entirely |
| `TROVE_MCP_RESOURCE` | the canonical public URL, when a proxy rewrites the Host |
| `TROVE_MCP_PATH` | serve it somewhere other than `/mcp` |
| `TROVE_MCP_REQUIRE_AUTH` | force auth on or off, rather than following the drive |

Note what is *not* in that table: the authorization server. Those four are all about
*this endpoint* — where it lives and whether it demands a token. Where the token comes
from belongs to the drive.

### Tools

| tool | |
| --- | --- |
| `search_files` | semantic + keyword search, `#tag` filters, across everything readable |
| `list_files` | page through a collection |
| `read_file` | text by id, name, or `trove:` URI |
| `write_file` | create or replace (needs write) |
| `delete_file` | to the trash, recoverable (needs delete) |
| `list_collections` | what you can see, and what you may do in each |
| `get_file_info` | type, size, tags, and backlinks |

Files are also exposed as MCP **resources** under their `trove:` URIs, for clients that
attach context rather than calling tools.

The server tells the model up front that this drive has no folders — otherwise every
assistant spends its first few turns constructing paths that don't exist.

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

### Writing a custom driver

Every seam is a small async class. Subclass it, pass the instance in, and the server
uses it — there is no registration step and no factory to teach about it, because
`resolve()` takes either an instance or a `{ driver }` config and an instance always
wins.

| you want to change | implement | the methods that matter |
| --- | --- | --- |
| where bytes live | `StorageBackend` | `put` `get` `delete` `list` `head` (+ `presign*`, `usage` if you can) |
| where records live | `MetadataStore` | `create` `getById` `listItems` `rename` `remove` `findByTags` … |
| the vector index | `VectorStore` | `add` `query` `remove{,ByNode,ByIndexer,ByNodeIndexer}` |
| the keyword index | `KeywordStore` | `add` `search` `remove*` `count` |
| how text becomes vectors | `EmbeddingProvider` | `embed(texts) -> number[][]` |
| SQL (D1, Turso, Postgres…) | `SqliteProvider` + `SqliteDatabase` | `obtain` / `exec` `run` `get` `all` `batch` |
| who the caller is | `IdentityProvider` | `authenticate(request) -> Principal \| null` |
| what a search query means | `SearchTransformer` | `transform(raw)` and `describe()` |
| shared small state | `KeyValueStore` | `get` `set` `delete` `list` |

```js
import { createServer } from '@trove/server';
import { VectorStore } from '@trove/core';

class PgVectorStore extends VectorStore {
  constructor(pool, { dimensions }) { super(); this.pool = pool; this.dimensions = dimensions; }
  async add(docs) { /* upsert (id, nodeId, indexerId, vector) */ }
  async query(vector, { limit = 20, collectionIds } = {}) {
    // return [{ id, nodeId, indexerId, score }] — score higher-is-better
  }
  async removeByNode(nodeId) { /* … */ }
  // removeByIndexer / removeByNodeIndexer / remove likewise
}

const { handle } = await createServer({
  vectorStore: new PgVectorStore(pool, { dimensions: 1536 }),
});
```

Two conventions the interfaces rely on, both of which will bite quietly if ignored:

- **Say what you can't do rather than pretending.** `StorageBackend.capabilities`
  advertises `presignDownload`, `list`, `usage` and friends, and callers branch on it —
  an S3 deployment uploads straight to the bucket while a filesystem one proxies,
  from the same client code. A backend that can't report free space returns `null` from
  `usage()` and the UI shows no gauge, rather than a meter built from a guess.
- **`durable` is a claim, not an inference.** A `SqliteProvider` that says `false` gets
  the in-memory search stores, because an index in an ephemeral database is worse than
  one in memory: it looks persistent right until the restart that proves it isn't.

`D1SqliteProvider` is worth reading as a worked example — it is the whole
`SqliteProvider` + `SqliteDatabase` pair against a database with a slightly different
dialect, in about a hundred lines, and its tests run the real `SqliteStore` and
`SqliteKV` against a D1-shaped shim.

Or drive the built-in drivers from env:

```sh
TROVE_VECTOR=qdrant TROVE_QDRANT_URL=http://localhost:6333 \
TROVE_QDRANT_COLLECTION=trove node packages/server/src/adapters/node.js
```

### Where the search index lives

`TROVE_VECTOR` (`sqlite` | `memory` | `qdrant` | `vectorize`) and `TROVE_KEYWORD`
(`sqlite` | `memory`) pick the stores. You normally set neither: a deployment with
a SQLite database gets the durable SQLite stores, and one with nothing to persist
to gets the in-memory ones — an index in an ephemeral database is worse than one
in memory, because it looks persistent until the restart that proves it isn't.
`GET /api/capabilities` reports which stores are in use and whether they're
`durable`.

FTS5 (keywords) is compiled into both `bun:sqlite` and `node:sqlite`, so there is
nothing to install. `sqlite-vec` (vectors) is a prebuilt native artifact and
therefore an **optional** dependency: if it can't load on your platform, Trove
logs a warning, keeps keyword search durable, and falls back to an in-memory
vector index rather than refusing to start.

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
node packages/web/test/multiuser.e2e.mjs       # access boundaries across 4 users & 2 collections, API + UI
node packages/web/test/probe/run-all.mjs        # error-path probes: broken openers, server faults, retry, uninstall failure, opener choice, activity/issues
node packages/web/test/probe/walkthrough.mjs    # full in-browser user journey + screenshots (test/screens/)
```

The web unit suites run under **both** `bun test` (fast, via `test/testkit.js`) and
`@web/test-runner` (a real browser, the platform plugins ship to) — the same files,
no duplication.

**Probes** (`test/probe/`) cover the error paths a happy-path e2e can't: an opener
whose bytes are missing, a server that 500s at startup, a failed search, a plugin whose
server-side uninstall fails. They deliberately trigger 404s and faults, so they live
outside the strict e2e suites. The **walkthrough** drives the whole app end to end and
screenshots each step — the "does it all still work together" check.

### Testing against S3

`bun test` runs the S3 backend against **s3rver**, an in-process S3 server (a
devDependency — no daemon, no container). That covers the wire protocol: paths,
Range, ETags, XML, and the multipart create/put/complete dance. It does **not**
cover authentication — s3rver doesn't implement SigV4 verification and will
accept any signature. Signing is covered separately in
`packages/core/test/s3sigv4.test.js`, which diffs our signer against `aws4` (an
independent implementation) and against AWS's own published example, so nothing
in the signing path is checked only by code we wrote.

For real-server fidelity — signature verification, the 5 MiB minimum part size,
real error codes — point the same tests at MinIO, Garage, R2, or S3:

```sh
docker run -p 9000:9000 -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin minio/minio server /data
# create the bucket, then:
TROVE_S3_TEST_ENDPOINT=http://127.0.0.1:9000 TROVE_S3_TEST_BUCKET=trove-test \
TROVE_S3_TEST_KEY=minioadmin TROVE_S3_TEST_SECRET=minioadmin \
bun test packages/core/test/s3-e2e.test.js
```

## License

MIT © Ray Stubbs
