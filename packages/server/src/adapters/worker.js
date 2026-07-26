// Cloudflare Worker adapter. A Worker's fetch handler is already Web-standard,
// so this is thin. Storage should be S3-compatible (R2 via the S3 API) so the
// SigV4 signer and presigned URLs work. Bind a D1 database as `DB` and metadata, the
// KV store, plugin installs, and keyword search persist there; bind `VECTORIZE` for the
// semantic half. Without `DB` everything falls back to memory, which looks fine until
// the isolate is recycled. Static assets are served from the ASSETS binding.
//
// wrangler.toml sketch:
//   [vars] TROVE_S3_BUCKET = "..."  TROVE_S3_REGION = "auto"
//   TROVE_S3_ENDPOINT = "https://<acct>.r2.cloudflarestorage.com"
//   (secrets: TROVE_S3_ACCESS_KEY_ID, TROVE_S3_SECRET_ACCESS_KEY)
//   [[d1_databases]] binding = "DB"          -> metadata, kv, keyword search
//   [[vectorize]]    binding = "VECTORIZE"   -> semantic search
//   [ai]             binding = "AI"          -> LLM query understanding (optional)

import { D1SqliteProvider } from '@trove/core';
import { createServer, configFromEnv } from '../index.js';

let cached = null;

/**
 * @param {object} env Worker env bindings
 * @param {(env) => object} [buildVfs] optional: return { storage, metadata } (e.g. D1)
 */
async function getServer(env, buildVfs) {
  if (cached) return cached;
  const config = configFromEnv(env);
  if (buildVfs) config.vfs = buildVfs(env);
  // D1 → metadata, kv, plugin installs, and the keyword half of search. Without this a
  // Worker falls back to in-memory everything, which looks like it works right up until
  // the isolate is recycled and the drive is empty. Bind `DB` and it persists.
  if (env.DB && !config.sqlite) {
    config.sqlite = new D1SqliteProvider({
      db: env.DB,
      // Plugin scopes need their own databases — D1 cannot create them on demand, and
      // co-locating them would put one plugin's tables next to the drive's metadata.
      scopes: env.PLUGIN_DB ? { plugins: env.PLUGIN_DB } : {},
    });
    config.metadata = { driver: 'sqlite' };
  }
  // Cloudflare Vectorize binding → first-class vector store (no REST creds needed).
  if (env.VECTORIZE) {
    config.vectorStore = { driver: 'vectorize', binding: env.VECTORIZE };
  }
  // Cloudflare Workers AI binding → LLM-assisted search transformer (human text →
  // semantic text + tag filters). Enabled just by binding `AI`; picks a cheap model.
  if (env.AI) {
    config.searchTransformer = { driver: 'workers-ai', ai: env.AI, model: env.TROVE_SEARCH_MODEL };
  }
  // Serve static assets from the ASSETS binding (Workers Sites / assets).
  if (env.ASSETS) {
    config.assets = async (req) => {
      const res = await env.ASSETS.fetch(req);
      return res.status === 404 ? null : res;
    };
  }
  cached = await createServer(config);
  return cached;
}

/** Default export usable directly as a Worker module. */
export default {
  async fetch(request, env, ctx) {
    const { handle } = await getServer(env);
    return handle(request);
  },
};

export { getServer };
