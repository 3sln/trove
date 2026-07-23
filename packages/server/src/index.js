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
  VectorStore, MemoryVectorStore, QdrantVectorStore,
  IndexerRegistry, textIndexer,
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
function buildMetadata(cfg) {
  switch (cfg.driver) {
    case 'sqlite': return new SqliteStore({ path: cfg.path });
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
    case 'memory': default: return new MemoryVectorStore({ dimensions });
  }
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
  const metadata = resolve(config.metadata ?? config.vfs?.metadata, MetadataStore, buildMetadata);
  const embeddings = resolve(config.embeddings, EmbeddingProvider, buildEmbeddings);
  const vectorStore = resolve(config.vectorStore, VectorStore, (cfg) => buildVectorStore(cfg, embeddings.dimensions));

  const search =
    config.search instanceof SearchService
      ? config.search
      : new SearchService({ embeddings, vectorStore, keywordStore: config.keywordStore });

  const indexers = config.indexers instanceof IndexerRegistry ? config.indexers : new IndexerRegistry();
  if (!indexers.indexers.size) indexers.register(textIndexer);

  const vfs = new Vfs({ storage, metadata, search, indexers });
  await vfs.init();

  const router = createRouter();

  async function handle(req) {
    const url = new URL(req.url);
    // API first, then static assets, then SPA fallback.
    if (url.pathname.startsWith('/api/')) {
      return router.handle(req, { vfs, config });
    }
    if (config.assets) {
      const asset = await config.assets(req);
      if (asset) return asset;
    }
    return new Response('Not found', { status: 404 });
  }

  return { vfs, handle, router };
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

  // Pluggable vector DB: default in-memory; point at Qdrant with a few vars.
  config.vectorStore.driver = env.TROVE_VECTOR || 'memory';
  if (config.vectorStore.driver === 'qdrant') {
    config.vectorStore.qdrant = {
      url: env.TROVE_QDRANT_URL || 'http://localhost:6333',
      collection: env.TROVE_QDRANT_COLLECTION || 'trove',
      apiKey: env.TROVE_QDRANT_API_KEY,
      distance: env.TROVE_QDRANT_DISTANCE || 'Cosine',
    };
  }

  return config;
}

export { createRouter };
