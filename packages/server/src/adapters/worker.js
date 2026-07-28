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
//   [[durable_objects.bindings]] name = "TASKS" class_name = "TroveTasks"
//                                            -> owns scans and reindexes (see below)

import { D1SqliteProvider } from '@3sln/trove/core';
import { createServer, configFromEnv } from '../index.js';
import { createTaskHost, remoteBackground } from './worker-tasks.js';

// Two DIFFERENT servers can be asked for here: the front-line one, which hands long
// work to the Durable Object, and the one INSIDE that object, which does it. Keyed,
// because they cannot share a slot — a delegating server handed back inside the object
// would have it forward work to itself. Cloudflare gives a Durable Object its own
// isolate today, so this has not been reachable; an invariant that costs one line to
// state is cheaper than one that holds by luck.
const cached = new Map();

/**
 * @param {object} env Worker env bindings
 * @param {(env) => object} [buildVfs] optional: return { storage, metadata } (e.g. D1)
 * @param {{delegate?: boolean}} [opts] delegate=false builds the server that DOES the
 *   background work (inside the Durable Object) rather than one that hands it off
 */
async function getServer(env, buildVfs, { delegate = true } = {}) {
  const slot = delegate ? 'edge' : 'worker';
  if (cached.has(slot)) return cached.get(slot);
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
  // The Durable Object that owns long work. Bound as TASKS, it becomes the one place
  // scans and reindexes run and the one place their tasks are listed — so a client
  // polling /api/tasks reaches the isolate that actually has the task, and Cancel
  // reaches the AbortController it is meant to abort. Without the binding the drive
  // still works: the work runs in the request isolate under waitUntil, which is what
  // it did before, with the caveats in the README.
  if (delegate && env.TASKS) {
    const remote = remoteBackground(env.TASKS);
    config.tasks = remote.tasks;
    config.background = remote.background;
    config.maintain = remote.maintain;
    // Timers do not survive a request here, and the object has its own alarm loop.
    config.startFlusher = false;
  }
  const server = await createServer(config);
  server.maintain = config.maintain || null;
  cached.set(slot, server);
  return server;
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
 *
 * A third piece, `TroveTasks`, is exported below: `waitUntil` can keep work alive but
 * cannot let another isolate SEE it, which is what progress polling and Cancel need.
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
    const budgetMs = Number(env.TROVE_CRON_BUDGET_MS || 20_000);
    // AWAITED, not fire-and-forget: `scheduled` gets its own budget, and the runtime
    // keeps the isolate alive exactly as long as this promise is pending. With the
    // Durable Object bound this hands the slice to it instead — the object then keeps
    // itself going on its own alarm, so a bucket too large for one firing does not
    // wait for the next cron tick to continue.
    const work = Promise.resolve(
      server.maintain ? server.maintain(budgetMs) : server.runMaintenance({ budgetMs }),
    ).catch((e) => console.error('[trove] scheduled maintenance failed', e));
    if (ctx?.waitUntil) ctx.waitUntil(work);
    await work;
  },
};

/**
 * The Durable Object class. Declare it in wrangler.toml and it becomes the home of
 * every scan and reindex — see worker-tasks.js for why that is the fix rather than
 * making the task list durable.
 *
 *   [[durable_objects.bindings]]
 *   name = "TASKS"
 *   class_name = "TroveTasks"
 *
 *   [[migrations]]
 *   tag = "v1"
 *   new_sqlite_classes = ["TroveTasks"]
 */
export const TroveTasks = createTaskHost((env) => getServer(env, undefined, { delegate: false }));

export { getServer };
