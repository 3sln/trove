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
      // Plugin storage. `scopes: { plugins: … }` named a key that is already a CORE key
      // (the install-record store), so the binding was silently ignored and every
      // /api/plugins/:id/sql call was a 501 — the real keys look like
      // `pstore:<user>:plg:<pluginId>` and cannot be pre-bound at all.
      pluginStore: env.PLUGIN_DB || null,
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

/**
 * Default export usable directly as a Worker module.
 *
 * Two things here are Workers-specific and neither is optional.
 *
 * `ctx.waitUntil` — a Worker's isolate may be torn down the moment the response
 * resolves. Work that was started and not awaited (a scan, a reindex) is not merely
 * slow after that, it is CANCELLED, at whatever point it had reached. `waitUntil` is
 * the only way to say "this response is done but I am not", so anything the request
 * kicked off is handed to it.
 *
 * `scheduled` — a Cron Trigger. `setInterval` is how a long-lived process does periodic
 * work and it does not work here at all: a timer registered inside a request does not
 * outlive the request, so the maintenance and scan intervals never fire on Workers.
 * Point a cron at the Worker and this runs one bounded slice per firing.
 *
 *   [triggers]
 *   crons = ["*​/5 * * * *"]
 */
export default {
  async fetch(request, env, ctx) {
    const server = await getServer(env);
    const res = await server.handle(request);
    // Anything the request started but did not await — see `pendingWork` below.
    const pending = server.tasks.pending?.();
    if (pending && ctx?.waitUntil) ctx.waitUntil(pending);
    return res;
  },

  /**
   * Cron Trigger. Sweeps expired uploads and idle sidecars, applies trash retention,
   * and advances each collection's scan by one time-boxed slice — the scanner stores
   * the cursor it reached, so the next firing continues rather than starting over.
   */
  async scheduled(event, env, ctx) {
    const server = await getServer(env);
    // AWAITED, not fire-and-forget: `scheduled` gets its own budget, and the runtime
    // keeps the isolate alive exactly as long as this promise is pending.
    const work = server.runMaintenance({ budgetMs: Number(env.TROVE_CRON_BUDGET_MS || 20_000) })
      .catch((e) => console.error('[trove] scheduled maintenance failed', e));
    if (ctx?.waitUntil) ctx.waitUntil(work);
    await work;
  },
};

export { getServer };
