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
  StorageBackend, MemoryStorage, S3Storage,
  StorageDriverRegistry, portableDrivers,
  MetadataStore, MemoryStore, SqliteStore,
  SearchService, EmbeddingProvider, LocalHashEmbedding, HttpEmbedding,
  SearchTransformer, ParsingSearchTransformer, WorkersAiSearchTransformer,
  VectorStore, MemoryVectorStore, QdrantVectorStore, VectorizeVectorStore, SqliteVectorStore,
  KeywordStore, MemoryKeywordStore, SqliteKeywordStore,
  IndexerRegistry,
  IdentityProvider, JwtIdentityProvider, HeaderIdentityProvider, AnonymousIdentityProvider,
  cloudflareAccess,
  KeyValueStore, MemoryKV, SqliteKV,
  KvSessionStore,
  RotationService,
  SqliteProvider, LocalSqliteProvider,
  SidecarService, NotificationCenter, WebPushService, WebPushChannel, NotificationChannel,
  ApiKeyService, CapabilityProvider, ApiKeyCapabilityProvider,
  CollectionService,
  PluginService, PackageStore, StoragePackageStore, SqlitePluginInstallStore,
  IndexerRuntime, InProcessIndexerRuntime, PluginIndexers,
  TaskRegistry, IssueRegistry,
  Vfs, TroveError,
  resolveAuthDiscovery,
  SignedUrls, resolveUrlSecret,
  diagnoseStorage, STORAGE_ISSUE_CODES,
  RateLimiter, MemoryRateStore, KvRateStore, DEFAULT_RATE_LIMITS,
} from '@3sln/trove/core';
import { Provider } from '@3sln/ngin';
import { need } from '../lazy.js';

// Injected instance or driver config — the duality the whole server is built on,
// and the only thing a provider has to decide before it builds anything.
const resolve = (value, BaseClass, build) =>
  (value instanceof BaseClass ? value : build(value || {}));

/**
 * The drivers this deployment can build, as a registry.
 *
 * `config.storageDrivers` either IS a registry or is a list of drivers to add to the
 * portable ones — so a deployment adds Filesystem (Node/Bun), or a driver written
 * entirely outside this package, by naming it at the entry point. What is not registered
 * is not offered and cannot be built.
 *
 * `config.allowedStorageDrivers` (TROVE_STORAGE_DRIVERS) narrows the result to an explicit
 * set. Adding drivers is a code decision made by an entry point, which knows what the
 * runtime can run; REMOVING them is an operator decision about one deployment, and needs
 * to be reachable from configuration alone. A drive on Workers is the case in point: memory
 * is portable, so it is offered, and choosing it there produces a collection that accepts
 * uploads and loses them when the isolate is recycled. `TROVE_STORAGE_DRIVERS=s3` takes it
 * off the menu without a fork of the entry point.
 *
 * A name that matches nothing throws rather than narrowing to nothing — a typo that left a
 * drive with no way to make a collection would be a puzzle, not a message.
 */
export function storageRegistry(config = {}) {
  if (config.storageRegistry instanceof StorageDriverRegistry) return config.storageRegistry;
  if (config.storageDrivers instanceof StorageDriverRegistry) return config.storageDrivers;
  const registry = new StorageDriverRegistry(portableDrivers());
  for (const d of config.storageDrivers || []) registry.register(d);

  const allowed = config.allowedStorageDrivers;
  if (!allowed?.length) return registry;
  const unknown = allowed.filter((k) => !registry.has(k));
  if (unknown.length) {
    throw TroveError.invalid(
      `TROVE_STORAGE_DRIVERS names ${unknown.map((k) => `"${k}"`).join(', ')}, which `
      + `${unknown.length === 1 ? 'is not a driver' : 'are not drivers'} this deployment has: `
      + `${registry.keys().join(', ')}`,
    );
  }
  // Rebuilt from the descriptors that survived rather than mutated, so a registry never
  // has to support removal — and the drivers keep their registration order.
  const narrowed = new StorageDriverRegistry();
  for (const key of registry.keys()) {
    if (allowed.includes(key)) narrowed.register(registry.driver(key));
  }
  return narrowed;
}

/**
 * Build a backend from a store config.
 *
 * The `default:` arm this replaces returned MemoryStorage, so a typo'd driver produced a
 * store that took writes and lost them at the next restart. Unknown drivers now throw and
 * say what is available.
 */
export function buildStorage(cfg, config = {}) {
  // ABSENT is not the same as WRONG, and conflating them is what the old `default:` arm
  // did. No storage configured at all is the zero-config path — `createServer()` with
  // nothing, which is ephemeral by definition — so it gets memory. A driver that was
  // NAMED and is not registered is a mistake, and throws: that is the case where a typo
  // used to buy you a store that took writes and lost them.
  if (!cfg?.driver) return new MemoryStorage();
  return storageRegistry(config).build(cfg);
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

    /**
     * What one caller may cost, per class of work.
     *
     * A provider so the route table can lease it like anything else, and so the store is a
     * decision made once from configuration rather than at each call site. Null when
     * limiting is switched off, which is the one case a caller has to handle — and it does
     * so by not asking, since `Router.handle` only enforces for routes that named a class.
     */
    rateLimiter: Provider.fromLazySingleton(
      async (deps) => {
        // ON unless switched off, including for a library caller who built a config by
        // hand rather than through `configFromEnv`. A limit that only exists when somebody
        // remembers to ask for it is not a limit.
        const rl = config.rateLimit ?? { enabled: true, store: 'memory', limits: DEFAULT_RATE_LIMITS };
        if (!rl.enabled) return null;
        // KV counters are shared across instances and cost a read and a write per limited
        // request; memory counters are free and exact on ONE long-lived process. See
        // rateLimit.js — the choice is a property of the deployment, not of the code.
        const store = rl.store === 'kv'
          ? new KvRateStore({ kv: (await need(deps, ['kv'])).kv })
          : new MemoryRateStore();
        return new RateLimiter({ store, limits: rl.limits || DEFAULT_RATE_LIMITS });
      },
      null,
      { deps: ['kv'] },
    ),

    // Shutdown, likewise. Long work has to be able to ask whether the server is
    // going down, and closing over a `let` made that invisible.
    lifecycle: Provider.fromSingleton({
      get closing() { return lifecycleState.closing; },
    }),

    // WHO RUNS LONG WORK.
    //
    // A scan or a reindex outlives the request that asked for it, and where it
    // runs is a deployment fact: in this process on Node and Bun, in a Durable
    // Object on Workers, because an isolate cannot own work that outlives a
    // response. That is the two-domain split — request and background — and it
    // is not a Workers concession. On a long-lived process the two domains
    // happen to share a process, which is the coincidence; Workers only makes
    // the seam visible by forcing it.
    //
    // So a route asks for `backgroundWork` and says what it wants started. It
    // does not know, and must not know, which process obliges.
    //
    // Late-bound through `lifecycleState`, which is the one honest circularity
    // here: dispatching needs the engine that owns this container, so it cannot
    // be a constructor dependency of something inside it.
    backgroundWork: Provider.fromSingleton({
      beginScan: (collectionId, opts) => lifecycleState.background.beginScan(collectionId, opts),
      beginReindex: (opts) => lifecycleState.background.beginReindex(opts),
    }),

    /**
     * The storage self-check.
     *
     * The failure this exists for: a bucket with no CORS policy serves the SERVER fine and
     * serves the browser nothing, so the drive looks healthy and every file opens to a
     * spinner. See core/storage/diagnose.js for why the check has to be a real preflight.
     *
     * `origin` is the browser origin to check the policy against, and there is no guessing
     * it: a policy may legitimately name one origin, so checking the wrong one would invent
     * a problem. A request supplies its own; a cron firing has only `config.publicUrl`, and
     * without either the CORS half is skipped rather than assumed.
     *
     * A PROVIDER, not a seam stamped onto `lifecycleState` after construction. The stated
     * reason for that shape was "it needs `collections` and `issues` from this container",
     * which is exactly what `fromLazySingleton` with deps is for — and unlike
     * `backgroundWork`, whose comment names a real circularity (dispatching needs the
     * engine that owns the container), there is none here.
     */
    storageCheck: Provider.fromLazySingleton(
      async (deps) => {
        const { collections, issues, config: cfg } = await need(deps, ['collections', 'issues', 'config']);
        const KIND = 'storage';
        return {
          async run({ origin = null } = {}) {
            // `all()`, not `list(null)`: this has no user, and asking what the anonymous
            // principal may read means checking nothing at all on a drive that is not public.
            const list = await collections.all().catch(() => []);
            const results = [];
            for (const c of list) {
              let findings;
              try {
                const storage = await collections.storageFor(c.id);
                findings = await diagnoseStorage({
                  storage, origin, driver: c.store?.driver || null, fetchImpl: cfg.fetch,
                });
              } catch (err) {
                // Failing to BUILD the store is itself the most severe version of
                // unreachable — an unknown driver, or a config missing a required field,
                // never gets far enough to be asked whether it can be read.
                findings = [{
                  code: 'storage-unreachable',
                  severity: 'error',
                  title: 'This collection\u2019s store could not be opened',
                  detail: err?.message || String(err),
                }];
              }
              const found = new Set(findings.map((f) => f.code));
              for (const f of findings) {
                await issues.raise({
                  kind: KIND,
                  subject: `${c.id}:${f.code}`,
                  title: `${c.name || c.id}: ${f.title}`,
                  detail: f.detail,
                  remedy: f.remedy || null,
                  severity: f.severity,
                  collectionId: c.id,
                  // Re-running the check IS the fix verification, so Retry rechecks against
                  // the same origin the finding was made for. Checking a different one
                  // would report a pass for a policy the affected browser still cannot use.
                  retry: { op: 'storage-check', origin },
                });
              }
              // Whatever is no longer true stops being listed. Without this, fixing the
              // bucket leaves the warning up, and a problem list that outlives its problems
              // is one people learn to scroll past.
              for (const code of STORAGE_ISSUE_CODES) {
                if (!found.has(code)) await issues.clear(KIND, `${c.id}:${code}`);
              }
              results.push({ collectionId: c.id, name: c.name || c.id, findings });
            }
            return { checked: results.length, corsChecked: !!origin, results };
          },
        };
      },
      null,
      { deps: ['collections', 'issues', 'config'] },
    ),

    storage: Provider.fromLazySingleton(
      () => resolve(config.storage ?? config.vfs?.storage, StorageBackend, (cfg) => buildStorage(cfg, config)),
    ),

    // One shared SQLite provider (a keyed pool) for metadata, kv, and per-plugin
    // scopes. Always present so plugin storage works regardless of the metadata
    // backend. Injectable, so a Worker supplies a D1-backed one instead.
    sqlite: Provider.fromLazySingleton(
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

    metadata: Provider.fromLazySingleton(
      async (deps) => {
        const { sqlite } = await need(deps, ['sqlite']);
        return resolve(config.metadata ?? config.vfs?.metadata, MetadataStore, (cfg) =>
          (cfg.driver === 'sqlite'
            ? new SqliteStore({ provider: sqlite, key: 'metadata' })
            : new MemoryStore()));
      },
      null,
      { deps: ['sqlite'] },
    ),

    embeddings: Provider.fromLazySingleton(
      () => resolve(config.embeddings, EmbeddingProvider, (cfg) =>
        (cfg.driver === 'http'
          ? new HttpEmbedding(cfg.http)
          : new LocalHashEmbedding({ dimensions: cfg.dimensions ?? 256 }))),
    ),

    search: Provider.fromLazySingleton(
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
      { deps: ['sqlite', 'embeddings'] },
    ),

    indexers: Provider.fromLazySingleton(() => resolve(config.indexers, IndexerRegistry, () => new IndexerRegistry())),

    // Raw query → { semanticText, tagFilters }. Default parses the `#tag` grammar;
    // inject one (Workers AI) for LLM-assisted query understanding.
    searchTransformer: Provider.fromLazySingleton(() => resolve(config.searchTransformer, SearchTransformer, (cfg) =>
      ((cfg?.driver === 'workers-ai' || config?.ai)
        ? new WorkersAiSearchTransformer({ ai: cfg?.ai || config?.ai, model: cfg?.model, run: cfg?.run })
        : new ParsingSearchTransformer()))),

    // BYO IdP. Default anonymous (single shared user) so a zero-config run works;
    // production injects a JwtIdentityProvider.
    identity: Provider.fromLazySingleton(() => resolve(config.identity, IdentityProvider, buildIdentity)),

    // Where an unauthenticated client is sent — ONE answer for the whole drive,
    // used by the JSON API's 401s and by MCP's discovery alike.
    auth: Provider.fromLazySingleton(() => resolveAuthDiscovery(config)),

    // Shared KV (subscriptions, inboxes, leases). Co-located in the main database
    // when there is one, so it actually persists.
    kv: Provider.fromLazySingleton(
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
      { deps: ['sqlite', 'metadata'] },
    ),

    // Signing for URLs that carry their own authorization — an <img src>, a <video src>,
    // an indexer handing a file to an external API. See docs/design/signed-urls.md.
    //
    // The secret is configured, or generated once and kept in the KV store. Generated is
    // safe rather than merely convenient BECAUSE it lives in the KV store: a per-process
    // random secret would work perfectly on one machine and reject half the URLs in
    // flight the moment a second instance answered a request.
    signedUrls: Provider.fromLazySingleton(
      async (deps) => {
        const { kv } = await need(deps, ['kv']);
        if (config.signedUrls instanceof SignedUrls) return config.signedUrls;
        return new SignedUrls({ secret: await resolveUrlSecret({ configured: config.urlSecret, kv }) });
      },
      null,
      { deps: ['kv'] },
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
    tasks: Provider.fromLazySingleton(() => resolve(config.tasks, TaskRegistry, () => new TaskRegistry())),

    // Moving a collection onto a new key, incrementally. Depends on vfs rather than the
    // other way round, so it sits after it in the graph and the container orders itself.
    rotation: Provider.fromLazySingleton(
      async (deps) => {
        const { kv, vfs, collections } = await need(deps, ['kv', 'vfs', 'collections']);
        return new RotationService({ kv, vfs, collections });
      },
      null,
      { deps: ['kv', 'vfs', 'collections'] },
    ),

    issues: Provider.fromLazySingleton(
      async (deps) => {
        const { kv } = await need(deps, ['kv']);
        return resolve(config.issues, IssueRegistry, () => new IssueRegistry({ kv }));
      },
      null,
      { deps: ['kv'] },
    ),

    push: Provider.fromLazySingleton(() => resolve(config.push, WebPushService, () =>
      (config.vapid?.publicKey && config.vapid?.privateKey
        ? new WebPushService({
          publicKey: config.vapid.publicKey,
          privateKey: config.vapid.privateKey,
          subject: config.vapid.subject || 'mailto:admin@example.com',
        })
        : null))),

    // How notifications actually reach people. A list, because there is no reason for
    // it to be one: a drive can push to browsers and mail a digest and post into a chat
    // workspace, and none of those knows about the others. Web push is the default and
    // only when VAPID is configured, so a drive that sets nothing gets an inbox and no
    // delivery — which is what it got before.
    //
    // `config.notificationChannels` replaces the list wholesale rather than adding to
    // it, so a caller who wants email INSTEAD of push says so by saying so.
    notificationChannels: Provider.fromLazySingleton(
      async (deps) => {
        const { kv, push } = await need(deps, ['kv', 'push']);
        if (config.notificationChannels) {
          return config.notificationChannels.filter(Boolean).map((c) => {
            if (!(c instanceof NotificationChannel)) {
              throw TroveError.invalid('Every notificationChannels entry must be a NotificationChannel');
            }
            return c;
          });
        }
        return push ? [new WebPushChannel({ kv, service: push })] : [];
      },
      null,
      { deps: ['kv', 'push'] },
    ),

    // The API key store. Keys grant capabilities and no identity — see core/apiKeys.js.
    apiKeys: Provider.fromLazySingleton(
      async (deps) => {
        const { kv } = await need(deps, ['kv']);
        return resolve(config.apiKeys, ApiKeyService, () => new ApiKeyService({ kv }));
      },
      null,
      { deps: ['kv'] },
    ),

    // How a credential becomes a capability grant. The counterpart to `identity`, and
    // separate from it on purpose: some credentials answer "what may this do" without
    // answering "who is this". Swap it to authorize from something else — a client
    // certificate, a signed webhook, a service mesh header.
    capabilities: Provider.fromLazySingleton(
      async (deps) => {
        const { apiKeys } = await need(deps, ['apiKeys']);
        return resolve(config.capabilities, CapabilityProvider,
          () => new ApiKeyCapabilityProvider({ apiKeys }));
      },
      null,
      { deps: ['apiKeys'] },
    ),

    notifications: Provider.fromLazySingleton(
      async (deps) => {
        const { kv, notificationChannels } = await need(deps, ['kv', 'notificationChannels']);
        const center = new NotificationCenter({
          kv, channels: notificationChannels, flushIntervalMs: config.mentionFlushMs ?? 30_000,
        });
        if (config.startFlusher !== false) center.start();
        return center;
      },
      // Stopping the flusher used to be a line in close() that had to remember this
      // existed. Now it is attached to the thing it stops.
      (center) => center.stop(),
      { deps: ['kv', 'notificationChannels'] },
    ),

    sidecar: Provider.fromLazySingleton(
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
      { deps: ['storage', 'issues', 'notifications'] },
    ),

    // The ownership + permission boundary; each collection is a store config.
    // There is no "off" any more. Every collection-scoped endpoint names its collection
    // in the path, so a drive with no collection layer has nothing to answer with — and
    // the ACL check standing down because the service is absent was the failure mode this
    // graph was rebuilt to make impossible. Refused here as well as in configFromEnv, so
    // there is one answer whichever way the config arrived.
    collections: Provider.fromLazySingleton(
      async (deps) => {
        if (config.collections === false) {
          throw TroveError.invalid(
            'collections: false is no longer supported — endpoints are scoped to a named '
            + 'collection. Create one collection and use it.',
          );
        }
        const { kv, storage } = await need(deps, ['kv', 'storage']);
        return resolve(config.collections, CollectionService, () => new CollectionService({
          kv,
          storageFactory: (storeConfig) => buildStorage(storeConfig, config),
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
      { deps: ['kv', 'storage'] },
    ),

    vfs: Provider.fromLazySingleton(
      async (deps) => {
        const r = await need(deps, [
          'storage', 'metadata', 'search', 'indexers', 'sidecar', 'collections',
          'searchTransformer', 'issues', 'signedUrls', 'kv',
        ]);
        const vfs = new Vfs({
          ...r,
          maxUploadBytes: config.maxUploadBytes ?? null,
          // Upload sessions in the KeyValueStore rather than this process's memory. An
          // upload spans several requests and the session is the only thing joining them,
          // so on a runtime that can serve those requests from different isolates an
          // in-memory Map means "upload session not found" on a drive where nothing is
          // wrong. See KvSessionStore.
          uploadSessions: new KvSessionStore({ kv: r.kv }),
          // Where this server can be reached from outside, for the URLs that leave the
          // browser (an indexer hands one to an external API). Absent, those are refused
          // rather than handed out as links to nowhere.
          publicUrl: config.publicUrl || '',
        });
        await vfs.init();
        return vfs;
      },
      null,
      { deps: ['storage', 'metadata', 'search', 'indexers', 'sidecar', 'collections', 'searchTransformer', 'issues', 'signedUrls', 'kv'] },
    ),

    // Bulk plugin package blobs. Defaults to the primary storage under a prefix;
    // TROVE_PACKAGE_STORE points it elsewhere.
    packageStore: Provider.fromLazySingleton(
      async (deps) => {
        const { storage } = await need(deps, ['storage']);
        return resolve(config.packages, PackageStore, () =>
          new StoragePackageStore(config.packageStore ? buildStorage(config.packageStore) : storage));
      },
      null,
      { deps: ['storage'] },
    ),

    // Server indexer sub-packages run through a pluggable runtime. The default is
    // the in-process (trusted) runner; a deployment swaps in an isolate runtime.
    indexerRuntime: Provider.fromLazySingleton(() =>
      (config.serverIndexers === false
        ? null
        : resolve(config.indexerRuntime, IndexerRuntime, () => new InProcessIndexerRuntime()))),

    plugins: Provider.fromLazySingleton(
      async (deps) => {
        const r = await need(deps, ['vfs', 'sqlite', 'packageStore', 'indexerRuntime', 'collections']);
        const service = new PluginService({
          packages: r.packageStore,
          installs: new SqlitePluginInstallStore({ provider: r.sqlite }),
          indexers: r.indexerRuntime
            ? new PluginIndexers({ vfs: r.vfs, runtime: r.indexerRuntime, packages: r.packageStore })
            : null,
          // Who may install a plugin. There is no "any authenticated caller qualifies"
          // fallback: the arm that provided one required `collections: false`, which this
          // provider refuses above and `configFromEnv` refuses again, so it could only ever
          // have fired for a direct-container caller — where it handed out an open drive.
          isAdmin: (principal) => r.collections.isAdmin(principal),
          maxPackageBytes: config.maxUploadBytes ?? undefined,
          strict: config.enforcePluginCaps === true,
        });
        await service.init();
        return service;
      },
      null,
      { deps: ['vfs', 'sqlite', 'packageStore', 'indexerRuntime', 'collections'] },
    ),
  };
}
