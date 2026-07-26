// createServer — assemble a Vfs from config and return a single
// `handle(request) -> Promise<Response>`. Runtime-agnostic: the Node and Worker
// adapters both just forward their platform request into `handle`.
//
// Config selects the pluggable backends. `configFromEnv` maps environment
// variables to that config so a container needs no code, and static assets
// (the built web app) can be served by passing an `assets` fetcher.

import {
  Vfs, StorageBackend, MemoryStorage, FilesystemStorage, S3Storage,
  MetadataStore, MemoryStore, SqliteStore,
  SearchService, EmbeddingProvider, LocalHashEmbedding, HttpEmbedding,
  SearchTransformer, ParsingSearchTransformer, WorkersAiSearchTransformer,
  VectorStore, MemoryVectorStore, QdrantVectorStore, VectorizeVectorStore, SqliteVectorStore,
  KeywordStore, MemoryKeywordStore, SqliteKeywordStore,
  IndexerRegistry,
  IdentityProvider, JwtIdentityProvider, HeaderIdentityProvider, AnonymousIdentityProvider,
  cloudflareAccess, accessHost,
  KeyValueStore, MemoryKV, SqliteKV,
  SqliteProvider, LocalSqliteProvider,
  SidecarService, NotificationCenter, WebPushService,
  CollectionService,
  PluginService, PackageStore, StoragePackageStore, SqlitePluginInstallStore,
  IndexerRuntime, InProcessIndexerRuntime, PluginIndexers,
  TaskRegistry, IssueRegistry,
  TroveError,
  resolveAuthDiscovery, protectedResourceMetadata, challengeHeaders, publicOrigin,
} from '@trove/core';
import { createRouter } from './routes.js';
import { createMcpHandler } from './mcp/index.js';

// Every backend is pluggable. Each field of `config` accepts EITHER a ready
// provider instance (pass your own class) OR a `{ driver, ... }` config object
// that these builders turn into one. `resolve` keeps that duality in one place,
// so the server constructor is a clean dependency-injection surface and core
// stays platform-agnostic.

function resolve(value, BaseClass, build) {
  if (value instanceof BaseClass) return value; // an injected provider instance
  return build(value || {}); // a { driver, ... } config (or nothing → default)
}

function buildStorage(cfg) {
  switch (cfg.driver) {
    case 's3': return new S3Storage(cfg.s3);
    case 'filesystem': return new FilesystemStorage({ root: cfg.root });
    case 'memory': default: return new MemoryStorage();
  }
}
function buildMetadata(cfg, sqliteProvider) {
  switch (cfg.driver) {
    case 'sqlite': return new SqliteStore({ provider: sqliteProvider, key: 'metadata' });
    case 'memory': default: return new MemoryStore();
  }
}
function buildEmbeddings(cfg) {
  if (cfg.driver === 'http') return new HttpEmbedding(cfg.http);
  return new LocalHashEmbedding({ dimensions: cfg.dimensions ?? 256 });
}
async function buildVectorStore(cfg, dimensions, sqlite) {
  switch (cfg.driver) {
    case 'qdrant': return new QdrantVectorStore({ dimensions, ...cfg.qdrant });
    case 'vectorize': return new VectorizeVectorStore({ dimensions, binding: cfg.binding, ...cfg.vectorize });
    case 'sqlite': {
      // sqlite-vec is an optional native dependency: absent on an unsupported platform
      // or a `--omit=optional` install. Degrade loudly to memory rather than refusing to
      // start — keyword search still works, and the warning says what was lost.
      const store = await SqliteVectorStore.open({ provider: sqlite, dimensions });
      if (store) return store;
      console.warn(
        '[trove] sqlite-vec is not loadable here — semantic search is falling back to an '
        + 'IN-MEMORY index that is rebuilt from scratch on every restart. Install the '
        + 'optional `sqlite-vec` dependency, or set TROVE_VECTOR to an external store.',
      );
      return new MemoryVectorStore({ dimensions });
    }
    case 'memory': default: return new MemoryVectorStore({ dimensions });
  }
}
// FTS5 is compiled into both bun:sqlite and node:sqlite, so unlike the vector half
// there is nothing here that can be missing.
async function buildKeywordStore(cfg, sqlite) {
  switch (cfg.driver) {
    case 'sqlite': return SqliteKeywordStore.open({ provider: sqlite });
    case 'memory': default: return new MemoryKeywordStore();
  }
}
// Search transformer factory. `parse` (default) is deterministic `#tag` parsing;
// `workers-ai` uses a Cloudflare Workers AI binding (injected by the worker adapter
// as config.searchTransformer.ai) or a REST runner, falling back to parsing.
function buildSearchTransformer(cfg, config) {
  if (cfg?.driver === 'workers-ai' || config?.ai) {
    return new WorkersAiSearchTransformer({ ai: cfg?.ai || config?.ai, model: cfg?.model, run: cfg?.run });
  }
  return new ParsingSearchTransformer();
}
function buildIdentity(cfg) {
  switch (cfg.driver) {
    // Cloudflare Access, configured by team name alone. Everything else about Access —
    // the JWKS path, the issuer, and (since managed OAuth) the authorization server an
    // agent signs in at — is that same domain, and writing it into three settings that
    // must agree is three chances to get it wrong.
    case 'cloudflare-access':
      return new JwtIdentityProvider(cloudflareAccess({ ...(cfg.access || {}), ...(cfg.jwt || {}) }));
    case 'jwt': return new JwtIdentityProvider(cfg.jwt || {});
    case 'header': return new HeaderIdentityProvider(cfg.header || {});
    case 'anonymous': default: return new AnonymousIdentityProvider();
  }
}
// The SQLite provider: a keyed pool the whole server shares (metadata + kv co-locate
// in the main db file; plugin scopes get isolated sibling files). Injectable, so a
// Worker can supply a D1/Durable-Object-backed provider instead.
function buildSqliteProvider(cfg) {
  return new LocalSqliteProvider({ path: cfg?.path || './data/trove.db' });
}

/**
 * Assemble the server. Any backend may be supplied as a provider instance
 * (dependency injection) or a driver-config object.
 * @param {object} config
 * @param {StorageBackend|{driver,root?,s3?}} [config.storage]
 * @param {MetadataStore|{driver,path?}} [config.metadata]
 * @param {EmbeddingProvider|{driver,http?,dimensions?}} [config.embeddings]
 * @param {VectorStore|{driver,qdrant?}} [config.vectorStore] the pluggable vector DB
 * @param {KeywordStore|{driver}} [config.keywordStore] the pluggable lexical index
 * @param {boolean} [config.rebuildIndexOnStart] false to skip the empty-index rebuild
 * @param {SearchService} [config.search] a fully-built search service (overrides the above)
 * @param {IndexerRegistry} [config.indexers]
 * @param {(req: Request) => Promise<Response|null>} [config.assets] static file fetcher
 * @param {object} [config.clientConfig] extra config surfaced at /api/capabilities
 * @returns {Promise<{ vfs: Vfs, handle: (req: Request) => Promise<Response> }>}
 */
export async function createServer(config = {}) {
  const storage = resolve(config.storage ?? config.vfs?.storage, StorageBackend, buildStorage);

  // One shared SQLite provider (keyed pool) for metadata, kv, and per-plugin scopes.
  // Always present so plugin storage works regardless of the metadata backend
  // (file-backed when metadata is sqlite, else ephemeral in-memory). Injectable, so
  // a Worker can supply a D1 / Durable-Object-backed provider instead.
  const sqliteProvider = resolve(config.sqlite, SqliteProvider, () =>
    buildSqliteProvider(config.sqlite || { path: config.metadata?.driver === 'sqlite' ? config.metadata.path : ':memory:' }));
  await sqliteProvider.init();

  const metadata = resolve(config.metadata ?? config.vfs?.metadata, MetadataStore, (cfg) => buildMetadata(cfg, sqliteProvider));
  const embeddings = resolve(config.embeddings, EmbeddingProvider, buildEmbeddings);

  // Where the search index lives follows the SQLite provider, not the config: the
  // question is whether there is somewhere durable to write, and only the provider
  // knows. A file-backed provider gets a SQLite index that survives a restart; an
  // in-memory one gets the memory stores, because an index in an ephemeral database is
  // strictly worse than one in memory — it looks persistent until the restart that
  // proves it isn't. An explicit driver in config always wins.
  const searchDriver = (cfg) => (cfg?.driver ? cfg : { ...cfg, driver: sqliteProvider.durable ? 'sqlite' : 'memory' });

  const search = await resolve(config.search, SearchService, async () => new SearchService({
    embeddings,
    vectorStore: await resolve(config.vectorStore, VectorStore, (cfg) =>
      buildVectorStore(searchDriver(cfg), embeddings.dimensions, sqliteProvider)),
    keywordStore: await resolve(config.keywordStore, KeywordStore, (cfg) =>
      buildKeywordStore(searchDriver(cfg), sqliteProvider)),
  }));

  const indexers = resolve(config.indexers, IndexerRegistry, () => new IndexerRegistry());

  // Search transformer: raw query → { semanticText, tagFilters }. Default parses the
  // `#tag` grammar; inject one (e.g. Workers AI) for LLM-assisted query understanding.
  const searchTransformer = resolve(config.searchTransformer, SearchTransformer, (cfg) => buildSearchTransformer(cfg, config));

  // Identity: BYO IdP. Default anonymous (single shared user) so a zero-config
  // run still works; production injects a JwtIdentityProvider (Cloudflare Access).
  const identity = resolve(config.identity, IdentityProvider, buildIdentity);

  // Shared KV (subscriptions, inboxes). When metadata is sqlite, KV shares the same
  // provider (co-located in the main db file) so it actually persists — memory
  // otherwise.
  const kv = resolve(config.kv, KeyValueStore, (cfg) =>
    (sqliteProvider && (cfg?.driver === 'sqlite' || metadata instanceof SqliteStore))
      ? new SqliteKV({ provider: sqliteProvider, key: 'kv' })
      : new MemoryKV());
  await kv.init?.();

  // The two halves of "tell the user what's going on", split by lifetime:
  //
  //   tasks   in-flight work, in memory, per-process. A reindex that was running when
  //           the server stopped is not running now — forgetting it is correct.
  //   issues  standing problems, in the KV store, durable. A file that failed to index
  //           is STILL unindexed after a restart, so this one has to survive.
  //
  // They meet at the retry: a failure raises an issue, retrying it starts a task, and
  // the task succeeding clears the issue.
  const tasks = resolve(config.tasks, TaskRegistry, () => new TaskRegistry());
  const issues = resolve(config.issues, IssueRegistry, () => new IssueRegistry({ kv }));

  // Web push (optional — only when VAPID keys are configured).
  const push = resolve(config.push, WebPushService, () =>
    config.vapid?.publicKey && config.vapid?.privateKey
      ? new WebPushService({ publicKey: config.vapid.publicKey, privateKey: config.vapid.privateKey, subject: config.vapid.subject || 'mailto:admin@example.com' })
      : null);

  // Mention batcher + inbox. Flushes on an interval (bodyless web push).
  const notifications = new NotificationCenter({ kv, push, flushIntervalMs: config.mentionFlushMs ?? 30_000 });

  // Sidecar conversations/tags/facets; mentions are piped to the batcher.
  const sidecar = resolve(config.sidecar, SidecarService, () => new SidecarService({
    storage,
    issues,
    onMentions: (mentions) => notifications.enqueue(mentions).catch((e) => console.error('enqueue mentions failed', e)),
  }));
  // Retrying a stuck write-back is the same verb the schedule uses, so a user pressing
  // "Retry" on the issue does exactly what the background retry would have.
  issues.handle('sidecar-flush', () => sidecar.manager.retryPending());

  // Collections — the ownership + permission boundary; each is a store config.
  // Disable with config.collections === false (single open storage, no ACLs).
  let collections = null;
  if (config.collections !== false) {
    collections = resolve(config.collections, CollectionService, () => new CollectionService({
      kv,
      storageFactory: (storeConfig) => buildStorage(storeConfig),
      admins: config.admins || [],
      creatorRoles: config.creatorRoles || [],
      defaultOpen: config.defaultOpen !== false,
      // Record the primary driver on 'default', but reuse its live instance.
      defaultStore: (config.storage && !(config.storage instanceof StorageBackend)) ? config.storage : { driver: config.storageDriver || 'memory' },
      storageOverrides: { default: storage },
    }));
  }

  const vfs = new Vfs({ storage, metadata, search, indexers, sidecar, collections, searchTransformer, issues, maxUploadBytes: config.maxUploadBytes ?? null });
  await vfs.init();

  // A drive with files and an empty index is a drive where nothing can be found, and
  // in an app where search IS the navigation that reads as data loss. It happens for
  // ordinary reasons — an index that lived in memory, a vector table dropped after an
  // embedding change, a restore from a metadata-only backup — so the fix is to notice
  // and rebuild rather than to assume it can't happen.
  //
  // Runs in the BACKGROUND: a rebuild re-reads every file, and holding up the server
  // until it finishes would turn a recoverable state into an outage. The promise is
  // returned so a caller (a test, a CLI) can wait for it.
  let closing = false;

  // ONE reindex verb, used by all three callers — the startup rebuild, the manual
  // command, and the retry on a failed-index issue. Written once so a user watching a
  // rebuild sees the same task whichever of them started it, and so "reindex" can't
  // drift into three subtly different operations.
  const startReindex = ({ reason, title } = {}) => tasks.run(
    {
      kind: 'index',
      title: title || 'Rebuilding the search index',
      detail: reason || null,
      unit: 'items',
      cancellable: true,
    },
    async (task) => {
      const result = await vfs.reindexAll({
        // The registry stops at a cancel; `closing` covers a shutdown, which is the
        // same need with no one to click the button.
        shouldStop: () => closing || task.cancelled,
        onProgress: ({ indexed, failed, total }) => task.progress({
          done: indexed,
          total,
          detail: failed ? `${failed} could not be indexed` : null,
        }),
      });
      if (result.stopped) throw TroveError.internal('Reindex stopped before it finished');
      return result;
    },
  );
  // Retrying an issue runs the same work as everything else, and reports it the same
  // way. The issue is not cleared here — it is cleared by the indexing that succeeds,
  // so a retry can't report success over a problem that is still there.
  issues.handle('reindex-all', () => startReindex({ reason: 'Retrying after a failed scan' }));
  // Reconcile a collection against what its store actually holds. Same three callers as
  // the reindex — scheduled, manual, and issue retry — through one verb.
  const startScan = (collectionId = 'default', { reason } = {}) => tasks.run(
    {
      kind: 'scan',
      title: `Scanning “${collectionId}” for outside changes`,
      detail: reason || null,
      unit: 'objects',
      collectionId,
      cancellable: true,
    },
    async (task) => vfs.scanCollection(collectionId, {
      shouldStop: () => closing || task.cancelled,
      // The store can't say how many objects it holds without listing them, so this is
      // honestly indeterminate: a count that rises, with no total to divide it by.
      onProgress: ({ scanned, adopted, refreshed }) => task.progress({
        done: scanned,
        detail: adopted || refreshed ? `${adopted} new, ${refreshed} changed` : null,
      }),
    }),
  );
  issues.handle('scan-collection', (issue) => startScan(issue.retry.collectionId, { reason: 'Retrying after a failed scan' }));

  issues.handle('reindex-node', (issue) => tasks.run(
    // Carries the issue's collection, so the person who can see the file can also see
    // the task fixing it — a task nobody is allowed to watch is not a task worth having.
    { kind: 'index', title: 'Re-indexing an item', detail: issue.title, collectionId: issue.collectionId },
    () => vfs.reindexNode(issue.retry.nodeId),
  ));

  const indexRebuild = config.rebuildIndexOnStart === false
    ? null
    : rebuildIndexIfLost(vfs, search, startReindex);

  // Server plugin installs: bulk package blobs go in a pluggable PackageStore
  // (default = the primary storage backend under a prefix; TROVE_PACKAGE_STORE points
  // it elsewhere), while install records live in the shared SQLite provider.
  const packageStore = resolve(config.packages, PackageStore, () =>
    new StoragePackageStore(config.packageStore ? buildStorage(config.packageStore) : storage));
  // Server indexer sub-packages run through a pluggable IndexerRuntime. The default is
  // the in-process (trusted) runner; a deployment swaps in an isolate runtime by
  // passing config.indexerRuntime. Set config.serverIndexers = false to disable them.
  const indexerRuntime = config.serverIndexers === false
    ? null
    : resolve(config.indexerRuntime, IndexerRuntime, () => new InProcessIndexerRuntime());
  const pluginIndexers = indexerRuntime
    ? new PluginIndexers({ vfs, runtime: indexerRuntime, packages: packageStore })
    : null;
  const plugins = new PluginService({
    packages: packageStore,
    installs: new SqlitePluginInstallStore({ provider: sqliteProvider }),
    indexers: pluginIndexers,
    isAdmin: (principal) => (collections ? collections.isAdmin(principal) : !!principal),
    maxPackageBytes: config.maxUploadBytes ?? undefined,
    strict: config.enforcePluginCaps === true,
  });
  await plugins.init();

  if (config.startFlusher !== false) notifications.start();

  // Periodic maintenance. Both of these caches are otherwise unbounded: abandoned
  // upload sessions (a client that starts an upload and never finishes) accumulate in
  // the session store forever, and sidecar documents stay resident after their last
  // access. Each has a sweep that had nothing calling it — this is that caller.
  let maintenance = null;
  if (config.startFlusher !== false && config.maintenanceIntervalMs !== 0) {
    const everyMs = config.maintenanceIntervalMs ?? 5 * 60 * 1000;
    // Trash retention. This is the only thing in Trove that destroys data on a timer,
    // so it is opt-outable (TROVE_TRASH_DAYS=0 keeps the trash forever) and it says what
    // it removed. 30 days is the same grace period the drives people are used to give.
    const trashMs = (config.trashRetentionDays ?? 30) * 86400_000;
    maintenance = setInterval(() => {
      Promise.resolve(vfs.uploads.sweepExpired(Date.now()))
        .then(() => sidecar.sweep?.())
        .then(() => (trashMs > 0 ? vfs.purgeTrash({ before: Date.now() - trashMs }) : null))
        .then((r) => { if (r?.purged) console.log(`[trove] purged ${r.purged} item(s) from the trash after ${config.trashRetentionDays ?? 30} days`); })
        .catch((e) => console.error('maintenance sweep failed', e));
    }, everyMs);
    maintenance.unref?.();
  }

  // Periodic reconciliation with the store. OFF by default (TROVE_SCAN_INTERVAL_MS):
  // a scan lists every object in the bucket, which on a large drive is real money on a
  // metered API and real load on a NAS. A deployment that shares its bucket with other
  // tools wants this on; one where Trove is the only writer doesn't need it at all, and
  // can scan on demand instead.
  let scanTimer = null;
  if (config.startFlusher !== false && config.scanIntervalMs) {
    scanTimer = setInterval(() => {
      if (tasks.list().some((t) => t.kind === 'scan' && t.status === 'running')) return; // still going
      Promise.resolve(collections ? collections.list(null).catch(() => []) : [{ id: 'default' }])
        .then(async (list) => {
          for (const c of list.length ? list : [{ id: 'default' }]) {
            await startScan(c.id, { reason: 'Scheduled' }).catch(() => {});
          }
        })
        .catch((e) => console.error('scheduled scan failed', e));
    }, config.scanIntervalMs);
    scanTimer.unref?.();
  }

  const router = createRouter();

  // Where an unauthenticated client is sent — ONE answer for the whole drive, used by
  // the JSON API's 401s and by MCP's discovery alike. Falls back to the JWT issuer,
  // which for essentially every OIDC provider IS the authorization server.
  const auth = resolveAuthDiscovery(config);
  // Said at boot, because that is when someone is looking and can still fix it. The
  // alternative is discovering it from a client that can't sign in and a 401 that
  // doesn't say why.
  for (const w of auth.warnings || []) console.warn(`[trove] ${w}`);

  // MCP: the same drive, the same identity, spoken to by an agent instead of a browser.
  // Null when switched off, and then nothing below routes to it.
  const mcp = createMcpHandler({
    vfs, collections, identity, config, auth,
    version: config.version || '0.0.1',
  });

  async function handle(req) {
    const url = new URL(req.url);

    // The drive's own protected-resource metadata. Same document MCP serves for its
    // endpoint, describing the drive instead — because "where do I sign in" has one
    // answer here and a client that found the drive should not have to know that MCP
    // exists to get it. Unauthenticated, necessarily: it is the way in.
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      return new Response(JSON.stringify(protectedResourceMetadata(publicOrigin(req, config), auth)), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'public, max-age=3600',
          'access-control-allow-origin': '*',
          'x-content-type-options': 'nosniff',
        },
      });
    }

    // Before the API check: the MCP endpoint and its discovery document live outside
    // /api/ because an agent is given ONE URL and everything it needs must hang off it.
    if (mcp) {
      const res = await mcp.handle(req, url);
      if (res) return res;
    }
    if (url.pathname.startsWith('/api/')) {
      // Authenticate every API request; a bad token is a clean 401, missing is
      // anonymous-or-401 per the provider's policy.
      let principal = null;
      try {
        principal = await identity.authenticate(req);
      } catch (err) {
        const e = err instanceof TroveError ? err : TroveError.unauthorized('Authentication failed');
        return withChallenge(new Response(JSON.stringify(e.toJSON()), { status: e.status, headers: { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' } }), req);
      }
      const res = await router.handle(req, { vfs, config, principal, sidecar, notifications, identity, collections, kv, sqlite: sqliteProvider, plugins, tasks, issues, startReindex, startScan, mcp, auth });
      // A route can refuse on its own (a token that verified but names nobody we know,
      // a session that expired between calls). Whatever refused, the answer to "so
      // where do I sign in" is the same one, so it is attached in one place rather
      // than at every throw site.
      return withChallenge(res, req);
    }
    if (config.assets) {
      const asset = await config.assets(req);
      if (asset) return hardenAsset(asset, config);
    }
    return new Response('Not found', { status: 404 });
  }

  /** Attach the sign-in directions to a 401 that doesn't already carry them. */
  function withChallenge(res, req) {
    if (res.status !== 401 || res.headers.has('www-authenticate')) return res;
    const headers = challengeHeaders(publicOrigin(req, config), auth);
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    // Without this a browser can't read the header cross-origin, which is exactly the
    // case where a client most needs it.
    const expose = res.headers.get('access-control-expose-headers');
    res.headers.set('access-control-expose-headers', expose ? `${expose}, www-authenticate` : 'www-authenticate');
    return res;
  }

  async function close() {
    // Tell an in-flight index rebuild to stop before the database goes away, and let it
    // unwind — otherwise every remaining file fails against a closing handle. Stopping
    // early is safe: a half-built index is still an empty-looking one, so the next
    // start rebuilds it.
    closing = true;
    await indexRebuild?.catch(() => {});
    notifications.stop();
    if (maintenance) clearInterval(maintenance);
    if (scanTimer) clearInterval(scanTimer);
    await sidecar.dispose?.();
    await sqliteProvider?.close();
  }

  return { vfs, handle, router, sidecar, notifications, identity, kv, collections, plugins, sqlite: sqliteProvider, tasks, issues, indexRebuild, startScan, mcp, auth, close };
}

/**
 * Rebuild the search index when it is empty but the drive is not. Resolves to null
 * when no rebuild was needed (the common case — every start after the first).
 * @returns {Promise<{indexed:number, failed:number}|null>}
 */
async function rebuildIndexIfLost(vfs, search, startReindex) {
  try {
    if (!search?.looksUnindexed) return null;
    // Cheapest question first: an index that reports documents needs nothing, and a
    // store that can't report (null) is never taken as evidence that it's empty.
    if ((await search.looksUnindexed()) !== true) return null;
    // …then the one that costs a query: is there anything to rebuild FROM?
    if (!(await vfs.metadata.scanItems({ limit: 1 })).length) return null;

    console.warn('[trove] the search index is empty but the drive is not — rebuilding it in the background');
    const started = Date.now();
    // Goes through the task registry like every other reindex, so a user who opens the
    // app mid-rebuild sees it running rather than a drive that mysteriously finds
    // nothing.
    const result = await startReindex({ reason: 'The index was empty and the drive was not' });
    console.log(`[trove] search index rebuilt: ${result.indexed} items in ${Date.now() - started}ms${result.failed ? `, ${result.failed} failed` : ''}`);
    return result;
  } catch (err) {
    // A failed or interrupted rebuild leaves a searchless-but-working drive; that has
    // to be said out loud, not swallowed into an unhandled rejection. The task record
    // already carries it for the UI; this is for the operator's log.
    console.warn('[trove] search index rebuild did not complete — items may not be findable:', err.message);
    return null;
  }
}

// A CSP starting point for deployments that DON'T rely on sandboxed plugins (opt in
// via TROVE_CSP). It is deliberately not shipped by default: Trove runs plugins in
// sandboxed, opaque-origin `srcdoc` iframes, which no `frame-src` source expression
// can match, so a strict shell CSP would break every plugin. The concrete
// same-origin XSS risk (opening an uploaded .html/.svg) is instead closed by forcing
// non-inline-safe downloads to `Content-Disposition: attachment` (see routes.js).
export const SAMPLE_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "connect-src 'self'",
].join('; ');

/**
 * Warn (once, to the console) when a configuration is world-open — anonymous auth
 * plus the default collection granting everyone every capability. Safe on
 * localhost, dangerous when exposed. Called by the runnable adapters at startup.
 */
export function warnOnOpenAccess(config = {}) {
  const anon = !config.identity || config.identity.driver === 'anonymous' || config.identity === 'anonymous';
  const open = config.collections !== false && config.defaultOpen !== false;
  if (anon && open) {
    console.warn(
      '[trove] SECURITY: anonymous auth + open default collection — anyone who can reach '
      + 'this server has full read/write/delete access. Set TROVE_AUTH (+ TROVE_AUTH_REQUIRED=true) '
      + 'and/or TROVE_DEFAULT_OPEN=false, and run behind an authenticating reverse proxy.',
    );
  }
}

/** Add security headers to a static/app-shell response (CSP only if configured). */
function hardenAsset(res, config = {}) {
  res.headers.set('x-content-type-options', 'nosniff');
  res.headers.set('x-frame-options', 'SAMEORIGIN');
  res.headers.set('referrer-policy', 'no-referrer');
  if (typeof config.csp === 'string') res.headers.set('content-security-policy', config.csp);
  return res;
}

/**
 * Parse a JWKS supplied inline as JSON.
 *
 * Inline only, because this module has to load unchanged on Cloudflare Workers, where
 * there is no filesystem to read a path from. Reading a KEY FILE is a Node/Bun concern
 * and lives in those adapters (TROVE_JWT_JWKS_FILE), which set this var before calling.
 *
 * A bad value throws at STARTUP rather than on the first request: a server that boots
 * with unreadable key material would authenticate nobody while looking perfectly
 * healthy, and would only admit it when someone tried to sign in.
 */
function parseJwks(value) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || (!Array.isArray(parsed) && !Array.isArray(parsed.keys))) {
      throw new Error('expected a JWKS document ({ keys: [...] }) or a bare array of JWKs');
    }
    return parsed;
  } catch (err) {
    throw TroveError.invalid(`TROVE_JWT_JWKS is not a usable key set: ${err.message}`);
  }
}

/** Map process.env → createServer config. */
// Build an S3 config block from env vars under `prefix` (e.g. 'TROVE_' or
// 'TROVE_PACKAGE_'), falling back through `fallbacks` prefixes then the standard AWS_*
// vars for credentials — so the same mapping serves primary storage and the package
// store without copy-paste.
function s3FromEnv(env, prefix, fallbacks = []) {
  const pick = (suffix, ...extra) => {
    for (const k of [prefix + suffix, ...fallbacks.map((f) => f + suffix), ...extra]) {
      if (env[k] != null && env[k] !== '') return env[k];
    }
    return undefined;
  };
  return {
    bucket: pick('S3_BUCKET'),
    region: pick('S3_REGION') || 'us-east-1',
    endpoint: pick('S3_ENDPOINT'),
    accessKeyId: pick('S3_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID'),
    secretAccessKey: pick('S3_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY'),
    sessionToken: pick('S3_SESSION_TOKEN'),
    forcePathStyle: pick('S3_PATH_STYLE') === 'true',
  };
}

export function configFromEnv(env = (typeof process !== 'undefined' ? process.env : {})) {
  const config = { storage: {}, metadata: {}, embeddings: {}, vectorStore: {} };

  config.storage.driver = env.TROVE_STORAGE || 'memory';
  if (config.storage.driver === 'filesystem') config.storage.root = env.TROVE_FS_ROOT || './data/objects';
  if (config.storage.driver === 's3') config.storage.s3 = s3FromEnv(env, 'TROVE_');

  config.metadata.driver = env.TROVE_METADATA || (config.storage.driver === 'memory' ? 'memory' : 'sqlite');
  config.metadata.path = env.TROVE_DB_PATH || './data/trove.db';

  if (env.TROVE_EMBEDDINGS_URL) {
    config.embeddings.driver = 'http';
    config.embeddings.http = {
      url: env.TROVE_EMBEDDINGS_URL,
      apiKey: env.TROVE_EMBEDDINGS_API_KEY,
      model: env.TROVE_EMBEDDINGS_MODEL,
      dimensions: Number(env.TROVE_EMBEDDINGS_DIM || 1536),
    };
  } else {
    config.embeddings.driver = 'local';
  }

  // Pluggable search stores. Deliberately left UNSET unless asked for: createServer
  // picks 'sqlite' or 'memory' from the SQLite provider it actually resolved, which is
  // the only thing that knows whether there's a durable database to write into (a
  // Worker supplying its own metadata store must not get a local SQLite index).
  //   TROVE_VECTOR  = sqlite | memory | qdrant | vectorize
  //   TROVE_KEYWORD = sqlite | memory
  if (env.TROVE_VECTOR) config.vectorStore.driver = env.TROVE_VECTOR;
  if (env.TROVE_KEYWORD) config.keywordStore = { driver: env.TROVE_KEYWORD };
  if (config.vectorStore.driver === 'qdrant') {
    config.vectorStore.qdrant = {
      url: env.TROVE_QDRANT_URL || 'http://localhost:6333',
      collection: env.TROVE_QDRANT_COLLECTION || 'trove',
      apiKey: env.TROVE_QDRANT_API_KEY,
      distance: env.TROVE_QDRANT_DISTANCE || 'Cosine',
    };
  }
  if (config.vectorStore.driver === 'vectorize') {
    // On Workers the binding is injected by the adapter; over REST use API creds.
    config.vectorStore.vectorize = {
      accountId: env.TROVE_VECTORIZE_ACCOUNT_ID || env.CF_ACCOUNT_ID,
      apiKey: env.TROVE_VECTORIZE_API_TOKEN,
      indexName: env.TROVE_VECTORIZE_INDEX || 'trove',
    };
  }

  // Where a refused client is told to sign in — one value for the whole drive, used by
  // every 401 the API returns and by the MCP discovery document alike. Left unset it
  // falls back to TROVE_JWT_ISSUER below, which for essentially every OIDC provider is
  // the same URL; set it when they genuinely differ.
  if (env.TROVE_AUTH_SERVER) config.authServer = env.TROVE_AUTH_SERVER;
  // The drive's own public URL. Behind a proxy the socket says http://internal:8787,
  // which is no use in a discovery document — but X-Forwarded-* is set by whoever is
  // talking to us unless a proxy is guaranteed to be in front, so honouring it is opt-in.
  if (env.TROVE_PUBLIC_URL) config.publicUrl = env.TROVE_PUBLIC_URL;
  if (env.TROVE_TRUST_PROXY != null) config.trustProxy = !/^(0|off|false|no)$/i.test(String(env.TROVE_TRUST_PROXY));

  // Identity: default anonymous; 'jwt' for a generic IdP, 'cloudflare-access' for Zero
  // Trust (which only needs the team name).
  config.identity = { driver: env.TROVE_AUTH || 'anonymous' };
  if (config.identity.driver === 'cloudflare-access') {
    config.identity.access = {
      team: env.TROVE_CF_ACCESS_TEAM,
      // The Access application's AUD tag. The one value that can't be derived from the
      // team, and the one that stops a token minted for a DIFFERENT application in the
      // same Access account from being accepted here.
      audience: env.TROVE_CF_ACCESS_AUD,
      required: env.TROVE_AUTH_REQUIRED !== 'false',
    };
    // Access is also where agents sign in (managed OAuth), and that is the same domain.
    // Derived rather than asked for again — see resolveAuthDiscovery's issuer fallback,
    // which this is just making explicit and immune to the issuer being unset.
    if (!config.authServer && env.TROVE_CF_ACCESS_TEAM) {
      config.authServer = `https://${accessHost(env.TROVE_CF_ACCESS_TEAM)}`;
    }
  }
  if (config.identity.driver === 'jwt') {
    config.identity.jwt = {
      jwksUrl: env.TROVE_JWKS_URL, // e.g. https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
      // The keychain: the keys this deployment trusts, named directly. A JWKS URL
      // assumes someone is running an endpoint to serve one, which a deployment that
      // mints its own tokens has no reason to do. Accepts inline JSON or a path to a
      // file — the file form keeps a multi-line document out of the environment, and
      // out of `docker inspect`.
      jwks: parseJwks(env.TROVE_JWT_JWKS),
      issuer: env.TROVE_JWT_ISSUER,
      audience: env.TROVE_JWT_AUDIENCE, // the Access application AUD
      secret: env.TROVE_JWT_SECRET, // HS256 dev only
      // Explicit allowlist. Without one, verifyJwt infers it from the key material
      // (HS256 for a secret, RS256/ES256 for a key set), which is the safe default —
      // set this only to narrow it further.
      algorithms: env.TROVE_JWT_ALGS ? env.TROVE_JWT_ALGS.split(',').map((a) => a.trim()).filter(Boolean) : undefined,
      required: env.TROVE_AUTH_REQUIRED === 'true',
    };
  } else if (config.identity.driver === 'header') {
    config.identity.header = {
      idHeader: env.TROVE_AUTH_ID_HEADER || 'cf-access-authenticated-user-email',
      emailHeader: env.TROVE_AUTH_EMAIL_HEADER || 'cf-access-authenticated-user-email',
      required: env.TROVE_AUTH_REQUIRED === 'true',
    };
  }

  // Web push (VAPID) for mention notifications — optional.
  if (env.TROVE_VAPID_PUBLIC_KEY && env.TROVE_VAPID_PRIVATE_KEY) {
    config.vapid = {
      publicKey: env.TROVE_VAPID_PUBLIC_KEY,
      privateKey: env.TROVE_VAPID_PRIVATE_KEY,
      subject: env.TROVE_VAPID_SUBJECT || 'mailto:admin@example.com',
    };
  }
  if (env.TROVE_MENTION_FLUSH_MS) config.mentionFlushMs = Number(env.TROVE_MENTION_FLUSH_MS);

  // KV store for subscriptions/inboxes: follows the metadata driver by default.
  config.kv = { driver: env.TROVE_KV || (config.metadata.driver === 'sqlite' ? 'sqlite' : 'memory'), path: config.metadata.path };

  // Collections: on by default. Admins (global) + roles that can create collections.
  if (env.TROVE_COLLECTIONS === 'false') config.collections = false;
  config.admins = (env.TROVE_ADMINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  config.creatorRoles = (env.TROVE_COLLECTION_CREATOR_ROLES || '').split(',').map((s) => s.trim()).filter(Boolean);
  // 'default' collection grants everyone all caps unless locked down.
  config.defaultOpen = env.TROVE_DEFAULT_OPEN !== 'false';

  // How long a deleted item stays recoverable. 0 keeps the trash forever — the only
  // setting here that can cause data loss, so it is explicit rather than inferred.
  if (env.TROVE_TRASH_DAYS != null && env.TROVE_TRASH_DAYS !== '') config.trashRetentionDays = Number(env.TROVE_TRASH_DAYS);

  // Reconcile with the object store on a timer. Off unless set: a scan lists the whole
  // bucket, which costs API calls and load. Turn it on when something other than Trove
  // writes to the same bucket.
  if (env.TROVE_SCAN_INTERVAL_MS) config.scanIntervalMs = Number(env.TROVE_SCAN_INTERVAL_MS);

  // Sweeping abandoned upload sessions and cold sidecars. Both caches are otherwise
  // unbounded, so this is a knob rather than a switch — 0 turns it off entirely.
  if (env.TROVE_MAINTENANCE_INTERVAL_MS != null && env.TROVE_MAINTENANCE_INTERVAL_MS !== '') {
    config.maintenanceIntervalMs = Number(env.TROVE_MAINTENANCE_INTERVAL_MS);
  }

  // Rebuilding the index at startup when it is empty and the drive is not. Wanted almost
  // always — an empty index in a search-first app reads as data loss — but on a very
  // large drive an operator may want to schedule it instead of paying for it on boot.
  if (env.TROVE_REBUILD_INDEX_ON_START != null && env.TROVE_REBUILD_INDEX_ON_START !== '') {
    config.rebuildIndexOnStart = !/^(0|off|false|no)$/i.test(String(env.TROVE_REBUILD_INDEX_ON_START));
  }

  // Per-file upload quota (bytes). Unbounded unless set.
  if (env.TROVE_MAX_UPLOAD_BYTES) config.maxUploadBytes = Number(env.TROVE_MAX_UPLOAD_BYTES);

  // Deny plugin API calls with no server install record (fully closes the "any client
  // can name any pluginId" gap). Off by default for back-compat with pre-existing
  // local-only installs; flip on once clients have re-uploaded their account plugins.
  if (env.TROVE_ENFORCE_PLUGIN_CAPS === 'true') config.enforcePluginCaps = true;

  // Server indexer sub-packages run in-process (trusted; admin-gated at install).
  // TROVE_SERVER_INDEXERS=0/false refuses server-indexer plugins on this deployment.
  if (env.TROVE_SERVER_INDEXERS === '0' || env.TROVE_SERVER_INDEXERS === 'false') config.serverIndexers = false;

  // Plugin package blob store: defaults to the primary storage backend (prefixed).
  // Point it at a separate bucket/root with TROVE_PACKAGE_STORE (+ its own settings).
  if (env.TROVE_PACKAGE_STORE) {
    config.packageStore = { driver: env.TROVE_PACKAGE_STORE };
    if (env.TROVE_PACKAGE_STORE === 'filesystem') config.packageStore.root = env.TROVE_PACKAGE_FS_ROOT || './data/packages';
    if (env.TROVE_PACKAGE_STORE === 's3') config.packageStore.s3 = s3FromEnv(env, 'TROVE_PACKAGE_', ['TROVE_']);
  }

  // Search transformer: 'parse' (default) or 'workers-ai' (Cloudflare Workers AI —
  // the binding is injected by the worker adapter; TROVE_SEARCH_MODEL picks the model).
  if (env.TROVE_SEARCH_TRANSFORMER === 'workers-ai') {
    config.searchTransformer = { driver: 'workers-ai', model: env.TROVE_SEARCH_MODEL };
  }

  // Cross-origin API access is off unless an origin (or '*') is configured.
  config.corsOrigin = env.TROVE_CORS_ORIGIN || null;
  // App-shell CSP is opt-in (see SAMPLE_CSP) — provide a full policy string to
  // enable it. Off by default because sandboxed plugin iframes can't satisfy one.
  if (env.TROVE_CSP && env.TROVE_CSP !== 'off') config.csp = env.TROVE_CSP;

  return config;
}

export { createRouter };
