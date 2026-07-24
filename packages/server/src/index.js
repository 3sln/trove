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
  VectorStore, MemoryVectorStore, QdrantVectorStore, VectorizeVectorStore,
  IndexerRegistry, textIndexer,
  IdentityProvider, JwtIdentityProvider, HeaderIdentityProvider, AnonymousIdentityProvider,
  KeyValueStore, MemoryKV, SqliteKV,
  SqliteProvider, LocalSqliteProvider,
  SidecarService, NotificationCenter, WebPushService,
  CollectionService,
  TroveError,
} from '@trove/core';
import { createRouter } from './routes.js';

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
function buildVectorStore(cfg, dimensions) {
  switch (cfg.driver) {
    case 'qdrant': return new QdrantVectorStore({ dimensions, ...cfg.qdrant });
    case 'vectorize': return new VectorizeVectorStore({ dimensions, binding: cfg.binding, ...cfg.vectorize });
    case 'memory': default: return new MemoryVectorStore({ dimensions });
  }
}
function buildIdentity(cfg) {
  switch (cfg.driver) {
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
 * @param {import('@trove/core').KeywordStore} [config.keywordStore]
 * @param {SearchService} [config.search] a fully-built search service (overrides the above)
 * @param {IndexerRegistry} [config.indexers]
 * @param {(req: Request) => Promise<Response|null>} [config.assets] static file fetcher
 * @param {object} [config.clientConfig] extra config surfaced at /api/capabilities
 * @returns {Promise<{ vfs: Vfs, handle: (req: Request) => Promise<Response> }>}
 */
export async function createServer(config = {}) {
  const storage = resolve(config.storage ?? config.vfs?.storage, StorageBackend, buildStorage);

  // One shared SQLite provider (keyed pool) for metadata, kv, and per-plugin scopes.
  // Built only when something needs sqlite; injectable for other runtimes (D1/DO).
  const wantsSqlite = config.sqlite || config.metadata?.driver === 'sqlite' || config.kv?.driver === 'sqlite';
  const sqliteProvider = config.sqlite instanceof SqliteProvider
    ? config.sqlite
    : wantsSqlite
      ? buildSqliteProvider(config.sqlite || { path: config.metadata?.path })
      : null;
  if (sqliteProvider) await sqliteProvider.init();

  const metadata = resolve(config.metadata ?? config.vfs?.metadata, MetadataStore, (cfg) => buildMetadata(cfg, sqliteProvider));
  const embeddings = resolve(config.embeddings, EmbeddingProvider, buildEmbeddings);
  const vectorStore = resolve(config.vectorStore, VectorStore, (cfg) => buildVectorStore(cfg, embeddings.dimensions));

  const search =
    config.search instanceof SearchService
      ? config.search
      : new SearchService({ embeddings, vectorStore, keywordStore: config.keywordStore });

  const indexers = config.indexers instanceof IndexerRegistry ? config.indexers : new IndexerRegistry();
  if (!indexers.indexers.size) indexers.register(textIndexer);

  // Identity: BYO IdP. Default anonymous (single shared user) so a zero-config
  // run still works; production injects a JwtIdentityProvider (Cloudflare Access).
  const identity = resolve(config.identity, IdentityProvider, buildIdentity);

  // Shared KV (subscriptions, inboxes). When metadata is sqlite, KV shares the same
  // provider (co-located in the main db file) so it actually persists — memory
  // otherwise.
  const kv = config.kv instanceof KeyValueStore
    ? config.kv
    : (sqliteProvider && (config.kv?.driver === 'sqlite' || metadata instanceof SqliteStore))
      ? new SqliteKV({ provider: sqliteProvider, key: 'kv' })
      : new MemoryKV();
  await kv.init?.();

  // Web push (optional — only when VAPID keys are configured).
  const push =
    config.push instanceof WebPushService
      ? config.push
      : config.vapid?.publicKey && config.vapid?.privateKey
        ? new WebPushService({ publicKey: config.vapid.publicKey, privateKey: config.vapid.privateKey, subject: config.vapid.subject || 'mailto:admin@example.com' })
        : null;

  // Mention batcher + inbox. Flushes on an interval (bodyless web push).
  const notifications = new NotificationCenter({ kv, push, flushIntervalMs: config.mentionFlushMs ?? 30_000 });

  // Sidecar conversations/tags/facets; mentions are piped to the batcher.
  const sidecar = config.sidecar ?? new SidecarService({
    storage,
    onMentions: (mentions) => notifications.enqueue(mentions).catch((e) => console.error('enqueue mentions failed', e)),
  });

  // Collections — the ownership + permission boundary; each is a store config.
  // Disable with config.collections === false (single open storage, no ACLs).
  let collections = null;
  if (config.collections !== false) {
    collections = config.collections instanceof CollectionService
      ? config.collections
      : new CollectionService({
          kv,
          storageFactory: (storeConfig) => buildStorage(storeConfig),
          admins: config.admins || [],
          creatorRoles: config.creatorRoles || [],
          defaultOpen: config.defaultOpen !== false,
          // Record the primary driver on 'default', but reuse its live instance.
          defaultStore: (config.storage && !(config.storage instanceof StorageBackend)) ? config.storage : { driver: config.storageDriver || 'memory' },
          storageOverrides: { default: storage },
        });
  }

  const vfs = new Vfs({ storage, metadata, search, indexers, sidecar, collections });
  await vfs.init();

  if (config.startFlusher !== false) notifications.start();

  const router = createRouter();

  async function handle(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      // Authenticate every API request; a bad token is a clean 401, missing is
      // anonymous-or-401 per the provider's policy.
      let principal = null;
      try {
        principal = await identity.authenticate(req);
      } catch (err) {
        const e = err instanceof TroveError ? err : TroveError.unauthorized('Authentication failed');
        return new Response(JSON.stringify(e.toJSON()), { status: e.status, headers: { 'content-type': 'application/json' } });
      }
      return router.handle(req, { vfs, config, principal, sidecar, notifications, identity, collections, kv, sqlite: sqliteProvider });
    }
    if (config.assets) {
      const asset = await config.assets(req);
      if (asset) return asset;
    }
    return new Response('Not found', { status: 404 });
  }

  async function close() {
    notifications.stop();
    await sidecar.dispose?.();
    await sqliteProvider?.close();
  }

  return { vfs, handle, router, sidecar, notifications, identity, kv, collections, sqlite: sqliteProvider, close };
}

/** Map process.env → createServer config. */
export function configFromEnv(env = (typeof process !== 'undefined' ? process.env : {})) {
  const config = { storage: {}, metadata: {}, embeddings: {}, vectorStore: {} };

  config.storage.driver = env.TROVE_STORAGE || 'memory';
  if (config.storage.driver === 'filesystem') config.storage.root = env.TROVE_FS_ROOT || './data/objects';
  if (config.storage.driver === 's3') {
    config.storage.s3 = {
      bucket: env.TROVE_S3_BUCKET,
      region: env.TROVE_S3_REGION || 'us-east-1',
      endpoint: env.TROVE_S3_ENDPOINT,
      accessKeyId: env.TROVE_S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.TROVE_S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.TROVE_S3_SESSION_TOKEN,
      forcePathStyle: env.TROVE_S3_PATH_STYLE === 'true',
    };
  }

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

  // Pluggable vector DB: default in-memory; Qdrant or Cloudflare Vectorize.
  config.vectorStore.driver = env.TROVE_VECTOR || 'memory';
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

  // Identity: default anonymous; 'jwt' for Cloudflare Access / Zero Trust.
  config.identity = { driver: env.TROVE_AUTH || 'anonymous' };
  if (config.identity.driver === 'jwt') {
    config.identity.jwt = {
      jwksUrl: env.TROVE_JWKS_URL, // e.g. https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
      issuer: env.TROVE_JWT_ISSUER,
      audience: env.TROVE_JWT_AUDIENCE, // the Access application AUD
      secret: env.TROVE_JWT_SECRET, // HS256 dev only
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

  return config;
}

export { createRouter };
