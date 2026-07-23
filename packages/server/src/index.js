// createServer — assemble a Vfs from config and return a single
// `handle(request) -> Promise<Response>`. Runtime-agnostic: the Node and Worker
// adapters both just forward their platform request into `handle`.
//
// Config selects the pluggable backends. `configFromEnv` maps environment
// variables to that config so a container needs no code, and static assets
// (the built web app) can be served by passing an `assets` fetcher.

import {
  Vfs, MemoryStorage, FilesystemStorage, S3Storage,
  MemoryStore, SqliteStore, SearchService, LocalHashEmbedding, HttpEmbedding,
  IndexerRegistry, textIndexer,
} from '@trove/core';
import { createRouter } from './routes.js';

function buildStorage(cfg = {}) {
  switch (cfg.driver) {
    case 's3': return new S3Storage(cfg.s3);
    case 'filesystem': return new FilesystemStorage({ root: cfg.root });
    case 'memory': default: return new MemoryStorage();
  }
}

function buildMetadata(cfg = {}) {
  switch (cfg.driver) {
    case 'sqlite': return new SqliteStore({ path: cfg.path });
    case 'memory': default: return new MemoryStore();
  }
}

function buildEmbeddings(cfg = {}) {
  if (cfg.driver === 'http') return new HttpEmbedding(cfg.http);
  return new LocalHashEmbedding({ dimensions: cfg.dimensions ?? 256 });
}

/**
 * @param {object} config
 * @param {object} [config.storage]   { driver, root?, s3? }
 * @param {object} [config.metadata]  { driver, path? }
 * @param {object} [config.embeddings]{ driver, http?, dimensions? }
 * @param {(req: Request) => Promise<Response|null>} [config.assets] static file fetcher
 * @param {object} [config.clientConfig] extra config surfaced at /api/capabilities
 * @returns {Promise<{ vfs: Vfs, handle: (req: Request) => Promise<Response> }>}
 */
export async function createServer(config = {}) {
  const storage = config.vfs?.storage ?? buildStorage(config.storage);
  const metadata = config.vfs?.metadata ?? buildMetadata(config.metadata);
  const embeddings = buildEmbeddings(config.embeddings);
  const search = new SearchService({ embeddings });
  const indexers = new IndexerRegistry();
  indexers.register(textIndexer);

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
  const config = { storage: {}, metadata: {}, embeddings: {} };

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

  return config;
}

export { createRouter };
