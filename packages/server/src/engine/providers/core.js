// The drive, as a dependency graph.
//
// This is what `createServer` used to do in 474 lines of statements whose order
// was the dependency graph, held in the author's head and re-derived by anyone
// reading it. Three things were maintained by hand there and are derived here:
//
//   • BUILD ORDER. sqlite before metadata before kv before issues before vfs,
//     because that is what the code said, not because anything checked. Now each
//     provider names what it needs and the container walks it — and refuses a
//     cycle by name rather than producing `undefined`.
//   • TEARDOWN ORDER. `close()` was a hand-written list that had to stay in
//     agreement with the build order and silently didn't have to. The container
//     disposes in reverse construction order, so a resource is always torn down
//     before the things it was built from.
//   • LAZINESS. `await sqlite.init()`, `await vfs.init()`, `await plugins.init()`
//     ran at construction whether or not anything used them. They now run on
//     first use, ordered by need.
//
// Every provider still accepts an injected instance, which is the property the
// whole test suite rests on: `createServer({ storage: new MemoryStorage() })`
// means the same thing it always did.

import {
  StorageBackend, MemoryStorage, FilesystemStorage, S3Storage,
  MetadataStore, MemoryStore, SqliteStore,
  SearchService, EmbeddingProvider, LocalHashEmbedding, HttpEmbedding,
  SearchTransformer, ParsingSearchTransformer, WorkersAiSearchTransformer,
  VectorStore, MemoryVectorStore, QdrantVectorStore, VectorizeVectorStore, SqliteVectorStore,
  KeywordStore, MemoryKeywordStore, SqliteKeywordStore,
  IndexerRegistry,
  IdentityProvider, JwtIdentityProvider, HeaderIdentityProvider, AnonymousIdentityProvider,
  cloudflareAccess,
  KeyValueStore, MemoryKV, SqliteKV,
  SqliteProvider, LocalSqliteProvider,
  SidecarService, NotificationCenter, WebPushService,
  CollectionService,
  PluginService, PackageStore, StoragePackageStore, SqlitePluginInstallStore,
  IndexerRuntime, InProcessIndexerRuntime, PluginIndexers,
  TaskRegistry, IssueRegistry,
  Vfs, TroveError,
  resolveAuthDiscovery,
} from '@trove/core';
import { Provider } from '@3sln/ngin';
import { lazySingleton, need } from '../lazy.js';

// Injected instance or driver config — the duality the whole server is built on,
// and the only thing a provider has to decide before it builds anything.
const resolve = (value, BaseClass, build) =>
  (value instanceof BaseClass ? value : build(value || {}));

export function buildStorage(cfg) {
  switch (cfg.driver) {
    case 's3': return new S3Storage(cfg.s3);
    case 'filesystem': return new FilesystemStorage({ root: cfg.root });
    case 'memory': default: return new MemoryStorage();
  }
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
    case 'anonymous': case undefined: case null: return new AnonymousIdentityProvider();
    default:
      // A typo must NOT open the drive. `TROVE_AUTH=JWT` (wrong case), `oidc`,
      // `cloudflare_access` all fell through to anonymous — which also skipped the
      // per-driver branch that reads TROVE_AUTH_REQUIRED, and silenced the boot warning
      // (it only fires when the driver string IS 'anonymous'). The result was a
      // world-readable, world-writable drive with a clean log, and an MCP endpoint that
      // dropped its own auth requirement because it sniffs the provider's class name.
      throw TroveError.invalid(
        `Unknown TROVE_AUTH driver "${cfg.driver}" — expected one of: anonymous, jwt, header, cloudflare-access`,
      );
  }
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

/**
 * The whole graph.
 *
 * @param {object} config the same config object `createServer` takes
 * @param {{closing: () => boolean}} lifecycleState
 */
export function coreProviders(config, lifecycleState) {
  return {
    // Config as a dependency rather than a captured variable, so a provider that
    // reads it has to say so.
    config: Provider.fromSingleton(config),

    // Shutdown, likewise. Long work has to be able to ask whether the server is
    // going down, and closing over a `let` made that invisible.
    lifecycle: Provider.fromSingleton({
      get closing() { return lifecycleState.closing; },
    }),

    storage: lazySingleton(
      () => resolve(config.storage ?? config.vfs?.storage, StorageBackend, buildStorage),
    ),

    // One shared SQLite provider (a keyed pool) for metadata, kv, and per-plugin
    // scopes. Always present so plugin storage works regardless of the metadata
    // backend. Injectable, so a Worker supplies a D1-backed one instead.
    sqlite: lazySingleton(
      async () => {
        const provider = resolve(config.sqlite, SqliteProvider, () => new LocalSqliteProvider({
          path: config.sqlite?.path
            || (config.metadata?.driver === 'sqlite' ? config.metadata.path : null)
            || ':memory:',
        }));
        await provider.init();
        return provider;
      },
      (provider) => provider.close?.(),
    ),

    metadata: lazySingleton(
      async (deps) => {
        const { sqlite } = await need(deps, ['sqlite']);
        return resolve(config.metadata ?? config.vfs?.metadata, MetadataStore, (cfg) =>
          (cfg.driver === 'sqlite'
            ? new SqliteStore({ provider: sqlite, key: 'metadata' })
            : new MemoryStore()));
      },
      null,
      ['sqlite'],
    ),

    embeddings: lazySingleton(
      () => resolve(config.embeddings, EmbeddingProvider, (cfg) =>
        (cfg.driver === 'http'
          ? new HttpEmbedding(cfg.http)
          : new LocalHashEmbedding({ dimensions: cfg.dimensions ?? 256 }))),
    ),

    search: lazySingleton(
      async (deps) => {
        const { sqlite, embeddings } = await need(deps, ['sqlite', 'embeddings']);
        if (config.search instanceof SearchService) return config.search;
        // Where the index lives follows the SQLite provider, not the config: the
        // question is whether there is somewhere durable to write, and only the
        // provider knows. A file-backed provider gets a SQLite index that survives a
        // restart; an in-memory one gets the memory stores, because an index in an
        // ephemeral database is strictly worse than one in memory — it looks
        // persistent until the restart that proves it isn't. An explicit driver wins.
        const driverFor = (cfg) =>
          (cfg?.driver ? cfg : { ...cfg, driver: sqlite.durable ? 'sqlite' : 'memory' });
        return new SearchService({
          embeddings,
          vectorStore: await resolve(config.vectorStore, VectorStore, (cfg) =>
            buildVectorStore(driverFor(cfg), embeddings.dimensions, sqlite)),
          keywordStore: await resolve(config.keywordStore, KeywordStore, (cfg) =>
            (driverFor(cfg).driver === 'sqlite'
              ? SqliteKeywordStore.open({ provider: sqlite })
              : new MemoryKeywordStore())),
        });
      },
      null,
      ['sqlite', 'embeddings'],
    ),

    indexers: lazySingleton(() => resolve(config.indexers, IndexerRegistry, () => new IndexerRegistry())),

    // Raw query → { semanticText, tagFilters }. Default parses the `#tag` grammar;
    // inject one (Workers AI) for LLM-assisted query understanding.
    searchTransformer: lazySingleton(() => resolve(config.searchTransformer, SearchTransformer, (cfg) =>
      ((cfg?.driver === 'workers-ai' || config?.ai)
        ? new WorkersAiSearchTransformer({ ai: cfg?.ai || config?.ai, model: cfg?.model, run: cfg?.run })
        : new ParsingSearchTransformer()))),

    // BYO IdP. Default anonymous (single shared user) so a zero-config run works;
    // production injects a JwtIdentityProvider.
    identity: lazySingleton(() => resolve(config.identity, IdentityProvider, buildIdentity)),

    // Where an unauthenticated client is sent — ONE answer for the whole drive,
    // used by the JSON API's 401s and by MCP's discovery alike.
    auth: lazySingleton(() => resolveAuthDiscovery(config)),

    // Shared KV (subscriptions, inboxes, leases). Co-located in the main database
    // when there is one, so it actually persists.
    kv: lazySingleton(
      async (deps) => {
        const { sqlite, metadata } = await need(deps, ['sqlite', 'metadata']);
        const store = resolve(config.kv, KeyValueStore, (cfg) =>
          ((cfg?.driver === 'sqlite' || metadata instanceof SqliteStore)
            ? new SqliteKV({ provider: sqlite, key: 'kv' })
            : new MemoryKV()));
        await store.init?.();
        return store;
      },
      null,
      ['sqlite', 'metadata'],
    ),

    // The two halves of "tell the user what's going on", split by lifetime:
    //
    //   tasks   in-flight work, in memory, per-process. A reindex that was running
    //           when the server stopped is not running now — forgetting it is correct.
    //   issues  standing problems, in the KV store, durable. A file that failed to
    //           index is STILL unindexed after a restart, so this one has to survive.
    //
    // They meet at the retry: a failure raises an issue, retrying it starts a task,
    // and the task succeeding clears the issue.
    tasks: lazySingleton(() => resolve(config.tasks, TaskRegistry, () => new TaskRegistry())),

    issues: lazySingleton(
      async (deps) => {
        const { kv } = await need(deps, ['kv']);
        return resolve(config.issues, IssueRegistry, () => new IssueRegistry({ kv }));
      },
      null,
      ['kv'],
    ),

    push: lazySingleton(() => resolve(config.push, WebPushService, () =>
      (config.vapid?.publicKey && config.vapid?.privateKey
        ? new WebPushService({
          publicKey: config.vapid.publicKey,
          privateKey: config.vapid.privateKey,
          subject: config.vapid.subject || 'mailto:admin@example.com',
        })
        : null))),

    notifications: lazySingleton(
      async (deps) => {
        const { kv, push } = await need(deps, ['kv', 'push']);
        const center = new NotificationCenter({ kv, push, flushIntervalMs: config.mentionFlushMs ?? 30_000 });
        if (config.startFlusher !== false) center.start();
        return center;
      },
      // Stopping the flusher used to be a line in close() that had to remember this
      // existed. Now it is attached to the thing it stops.
      (center) => center.stop(),
      ['kv', 'push'],
    ),

    sidecar: lazySingleton(
      async (deps) => {
        const { storage, issues, notifications } = await need(deps, ['storage', 'issues', 'notifications']);
        return resolve(config.sidecar, SidecarService, () => new SidecarService({
          storage,
          issues,
          onMentions: (mentions) =>
            notifications.enqueue(mentions).catch((e) => console.error('enqueue mentions failed', e)),
        }));
      },
      (sidecar) => sidecar.dispose?.(),
      ['storage', 'issues', 'notifications'],
    ),

    // The ownership + permission boundary; each collection is a store config.
    // `config.collections === false` disables it (single open storage, no ACLs),
    // and the resource is then null — a provider is allowed to provide nothing.
    collections: lazySingleton(
      async (deps) => {
        if (config.collections === false) return null;
        const { kv, storage } = await need(deps, ['kv', 'storage']);
        return resolve(config.collections, CollectionService, () => new CollectionService({
          kv,
          storageFactory: (storeConfig) => buildStorage(storeConfig),
          admins: config.admins || [],
          creatorRoles: config.creatorRoles || [],
          defaultOpen: config.defaultOpen !== false,
          // Record the primary driver on 'default', but reuse its live instance.
          defaultStore: (config.storage && !(config.storage instanceof StorageBackend))
            ? config.storage
            : { driver: config.storageDriver || 'memory' },
          storageOverrides: { default: storage },
        }));
      },
      null,
      ['kv', 'storage'],
    ),

    vfs: lazySingleton(
      async (deps) => {
        const r = await need(deps, [
          'storage', 'metadata', 'search', 'indexers', 'sidecar', 'collections',
          'searchTransformer', 'issues',
        ]);
        const vfs = new Vfs({ ...r, maxUploadBytes: config.maxUploadBytes ?? null });
        await vfs.init();
        return vfs;
      },
      null,
      ['storage', 'metadata', 'search', 'indexers', 'sidecar', 'collections', 'searchTransformer', 'issues'],
    ),

    // Bulk plugin package blobs. Defaults to the primary storage under a prefix;
    // TROVE_PACKAGE_STORE points it elsewhere.
    packageStore: lazySingleton(
      async (deps) => {
        const { storage } = await need(deps, ['storage']);
        return resolve(config.packages, PackageStore, () =>
          new StoragePackageStore(config.packageStore ? buildStorage(config.packageStore) : storage));
      },
      null,
      ['storage'],
    ),

    // Server indexer sub-packages run through a pluggable runtime. The default is
    // the in-process (trusted) runner; a deployment swaps in an isolate runtime.
    indexerRuntime: lazySingleton(() =>
      (config.serverIndexers === false
        ? null
        : resolve(config.indexerRuntime, IndexerRuntime, () => new InProcessIndexerRuntime()))),

    plugins: lazySingleton(
      async (deps) => {
        const r = await need(deps, ['vfs', 'sqlite', 'packageStore', 'indexerRuntime', 'collections']);
        const service = new PluginService({
          packages: r.packageStore,
          installs: new SqlitePluginInstallStore({ provider: r.sqlite }),
          indexers: r.indexerRuntime
            ? new PluginIndexers({ vfs: r.vfs, runtime: r.indexerRuntime, packages: r.packageStore })
            : null,
          isAdmin: (principal) => (r.collections ? r.collections.isAdmin(principal) : !!principal),
          maxPackageBytes: config.maxUploadBytes ?? undefined,
          strict: config.enforcePluginCaps === true,
        });
        await service.init();
        return service;
      },
      null,
      ['vfs', 'sqlite', 'packageStore', 'indexerRuntime', 'collections'],
    ),
  };
}
