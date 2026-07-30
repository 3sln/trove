// @3sln/trove/core — runtime-agnostic building blocks for a self-hostable drive.
// Import the pieces directly, or use `createVfs` to wire a sensible default.

export { TroveError, ErrorCode, wrapError, isRetryable, isOutOfSpace } from './errors.js';
export { withRetry, withTimeout } from './retry.js';
export * from './util.js';
export * from './links.js';

export { StorageBackend } from './storage/interface.js';
export { MemoryStorage } from './storage/memory.js';
// FilesystemStorage is NOT exported here on purpose. It imports node:fs at the top level,
// so re-exporting it from the barrel put node:fs into every bundle that touched core —
// including Cloudflare Workers, which is the only reason a Workers build needed
// nodejs_compat. Import it (and `filesystemDriver`) from
// '@3sln/trove/core/storage/filesystem.js' in an entry point that has a filesystem.
export { StorageDriverRegistry } from './storage/registry.js';
export { portableDrivers } from './storage/drivers.js';
export { diagnoseStorage, corsPolicy, STORAGE_ISSUE_CODES } from './storage/diagnose.js';
export { S3Storage } from './storage/s3.js';
export { PrefixedStorage } from './storage/prefixed.js';

export { MetadataStore } from './metadata/interface.js';
export { MemoryStore } from './metadata/memory.js';
export { SqliteStore } from './metadata/sqlite.js';

export { CollectionService, CAPABILITIES, expand as expandCapabilities } from './collections/index.js';

export { SearchService } from './search/index.js';
export { SearchTransformer, ParsingSearchTransformer, WorkersAiSearchTransformer, parseTagFilters, matchTagFilters } from './search/transformer.js';
export { VectorStore, MemoryVectorStore, QdrantVectorStore } from './search/vectorStore.js';
export { KeywordStore, MemoryKeywordStore } from './search/keywordStore.js';
export { EmbeddingProvider, LocalHashEmbedding, HttpEmbedding } from './search/embeddings.js';
// Durable local search: vectors via sqlite-vec, keywords via FTS5, both in the
// SQLite file the metadata already lives in.
export { SqliteVectorStore, SqliteKeywordStore, SEARCH_DB_KEY } from './search/sqliteStores.js';

export { IndexerRegistry, textIndexer, chunkText } from './indexers/registry.js';
export { PluginService, PackageStore, StoragePackageStore, PluginInstallStore, SqlitePluginInstallStore, MemoryPluginInstallStore, parsePluginPackage, capabilityList, ALL_CAPABILITIES, IndexerRuntime, InProcessIndexerRuntime, PluginIndexers, matchFromSelector } from './plugins/index.js';
export { UploadManager, KvSessionStore, DEFAULT_PART_SIZE } from './uploads.js';
// Encryption at rest: the bucket holds ciphertext, the drive holds the key. Protects
// against the STORAGE host (a leaked bucket credential, a storage vendor who is not the
// compute vendor) and deliberately not against the server, which must read plaintext to
// index it. See encryption/keys.js for why nothing here is a plain hash of a passphrase.
export {
  encrypt, decrypt, decryptRange, encodeHeader, decodeHeader, isEnvelope,
  cipherSize, plaintextSizeOf, cipherRangeFor,
  HEADER_BYTES, TAG_BYTES, DEFAULT_CHUNK_SIZE,
} from './encryption/envelope.js';
export {
  deriveDataKey, fingerprint, fingerprintHex, toHex, describeKey, matchesCollection,
  newSalt, DEFAULT_KDF,
} from './encryption/keys.js';
export { Vfs, CONTENT_TYPES } from './vfs.js';
export { IndexingCoordinator } from './indexing.js';
// Work in flight (ephemeral) and standing problems (durable) — see the header of each.
export { TaskRegistry } from './tasks.js';
export { IssueRegistry, issueId } from './issues.js';
// Reconcile a collection against what its store actually holds (changes made outside Trove).
export { CollectionScanner } from './scan.js';
export { normalizeContribution, clampContribution, clampTagValue, DEFAULT_CAPS } from './indexers/contribution.js';

// Cloudflare Vectorize — first-class pluggable vector DB.
export { VectorizeVectorStore } from './search/vectorize.js';

// Server-side key/value store (subscriptions, inboxes, profiles).
export { KeyValueStore, MemoryKV, SqliteKV } from './kv.js';
export { SignedUrls, resolveUrlSecret, URL_PURPOSES } from './signedUrls.js';
// API keys: capability without identity. CapabilityProvider is the injection point —
// the counterpart to IdentityProvider, for credentials that say what rather than who.
export {
  ApiKeyService, ApiKeyGrant, ApiKeyCapabilityProvider, CapabilityProvider, ANY_COLLECTION,
} from './apiKeys.js';
export { SqliteDatabase, SqliteProvider, LocalSqliteProvider, assertSafePluginSql, stripSqlLiterals } from './sqlite.js';
// SQLite on Cloudflare D1, so a Worker deployment has a metadata store that exists.
export { D1SqliteProvider } from './sqlite-d1.js';

// Identity (BYO IdP — Cloudflare Access / Zero Trust / a proxy).
export {
  IdentityProvider, JwtIdentityProvider, HeaderIdentityProvider,
  AnonymousIdentityProvider, principalFromClaims,
  cloudflareAccess, accessHost,
} from './identity/index.js';
export { verifyJwt, decodeJwt, JwksClient, StaticJwks } from './identity/jwt.js';
// Where an unauthenticated client is told to go — one answer for the whole drive.
export {
  protectedResourceMetadata, challengeHeaders, metadataUrl, publicOrigin,
  normalizeServers, resolveAuthDiscovery, usableAuthServer, headerSafe,
} from './identity/discovery.js';

// Sidecar documents: conversations, tags, indexer facets (CRDT, cold-in-S3).
export { SidecarService, SidecarStore, SidecarManager } from './sidecar/index.js';
export * as sidecarOps from './sidecar/document.js';

// Notifications: mention batching and the inbox, plus the channels that deliver.
// `NotificationChannel` is the extension point — subclass it for email or chat.
export { NotificationCenter } from './notifications/index.js';
export { NotificationChannel } from './notifications/channel.js';
export { WebPushService, WebPushChannel, generateVapidKeys } from './notifications/webpush.js';

import { Vfs } from './vfs.js';
import { MemoryStorage } from './storage/memory.js';
import { MemoryStore } from './metadata/memory.js';
import { SearchService } from './search/index.js';
import { LocalHashEmbedding } from './search/embeddings.js';
import { IndexerRegistry } from './indexers/registry.js';

/**
 * Wire a Vfs from parts, defaulting to in-memory everything (great for tests and
 * a zero-config first run). Pass real backends for production:
 *
 *   createVfs({
 *     storage: new S3Storage({ ... }),
 *     metadata: new SqliteStore({ provider: new LocalSqliteProvider({ path: 'trove.db' }) }),
 *     embeddings: new HttpEmbedding({ url, apiKey, model, dimensions: 1536 }),
 *   })
 *
 * @param {object} [opts]
 * @returns {Promise<Vfs>} initialised (metadata.init already run)
 */
export async function createVfs(opts = {}) {
  const storage = opts.storage ?? new MemoryStorage();
  const metadata = opts.metadata ?? new MemoryStore();
  const embeddings = opts.embeddings ?? new LocalHashEmbedding();
  const search =
    opts.search ??
    new SearchService({ embeddings, vectorStore: opts.vectorStore, keywordStore: opts.keywordStore });
  const indexers = opts.indexers ?? new IndexerRegistry();
  const vfs = new Vfs({ storage, metadata, search, indexers, sidecar: opts.sidecar, collections: opts.collections, searchTransformer: opts.searchTransformer, issues: opts.issues, maxIndexBytes: opts.maxIndexBytes, maxUploadBytes: opts.maxUploadBytes, uploadPartSize: opts.uploadPartSize });
  await vfs.init();
  return vfs;
}
