// createServer — assemble a Vfs from config and return a single
// `handle(request) -> Promise<Response>`. Runtime-agnostic: the Node and Worker
// adapters both just forward their platform request into `handle`.
//
// Config selects the pluggable backends. `configFromEnv` maps environment
// variables to that config so a container needs no code, and static assets
// (the built web app) can be served by passing an `assets` fetcher.

// Only the names this module still touches. Everything that BUILDS a backend moved
// to engine/providers/core.js when the drive became a dependency graph; the class
// names that remain are the JSDoc types of `createServer`'s injection surface, which
// is the part of that duality callers still read.
import {
  Vfs, StorageBackend, MetadataStore, SearchService, EmbeddingProvider,
  VectorStore, KeywordStore, IndexerRegistry,
  accessHost, TroveError,
  protectedResourceMetadata, challengeHeaders, publicOrigin,
} from '@3sln/trove/core';
import { createRouter, routeHelpers } from './routes.js';
import { createDriveEngine, scanStarter, BACKBONE } from './engine/index.js';
import { createMcpHandler } from './mcp/index.js';
import { cacheControlFor } from './cachePolicy.js';
import { MANIFEST_PATH, webManifest, manifestFromEnv } from './manifest.js';

// Every backend is pluggable. Each field of `config` accepts EITHER a ready
// provider instance (pass your own class) OR a `{ driver, ... }` config object
// that these builders turn into one. `resolve` keeps that duality in one place,
// so the server constructor is a clean dependency-injection surface and core
// stays platform-agnostic.



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
  // The drive is a dependency graph now — see engine/providers/core.js. What was
  // 200 lines of statements whose ORDER was the graph is a declaration the
  // container walks, which is also what makes `close()` stop being a hand-kept
  // list that had to agree with it.
  const lifecycleState = { closing: false, background: null };
  const engine = createDriveEngine(config, lifecycleState);

  // Obtained up front because they are this function's return value: callers
  // hold `server.vfs` and `server.kv` directly, and a facade handing back
  // promises for them would break every one of them.
  const backbone = await engine.container.lease(BACKBONE);
  const {
    storage, sqlite: sqliteProvider, metadata, kv, tasks, issues, notifications,
    sidecar, collections, identity, auth, search, vfs, plugins, apiKeys, capabilities,
  } = backbone.resources;

  // Aliased so the rest of this function reads as it did; the container's
  // `lifecycle` provider is the same flag, which is how a long-running action
  // can ask whether the server is going down without closing over anything.
  const closing = () => lifecycleState.closing;

  // ONE reindex verb, used by all three callers — the startup rebuild, the manual
  // command, and the retry on a failed-index issue. Written once so a user watching a
  // rebuild sees the same task whichever of them started it, and so "reindex" can't
  // drift into three subtly different operations.
  // `begin*` hands back the task record straight away and the work as a promise;
  // `start*` is the same thing for callers that only want the outcome. A route needs
  // the first — it has to answer with something the client can watch, and it cannot
  // wait for a reindex to finish to find out what that is.
  const beginReindex = async ({ reason, title } = {}) => {
    // Drive-wide, so one claim for the whole drive. Two concurrent full rebuilds do
    // double the work to reach the same place, and on a metered backend that is real
    // money — the same reason the route checks its local task list, made true across
    // processes rather than only within one.
    const token = await kv.acquire('reindex', 'all', 60_000);
    if (!token) {
      return { task: null, alreadyRunning: true, done: Promise.resolve({ alreadyRunning: true, indexed: 0, failed: 0, total: 0, stopped: false }) };
    }
    {
      const begun = tasks.begin(
        {
          kind: 'index',
          title: title || 'Rebuilding the search index',
          detail: reason || null,
          unit: 'items',
          cancellable: true,
        },
        async (task) => {
          let renewedAt = Date.now();
          const result = await vfs.reindexAll({
            // The registry stops at a cancel; `closing` covers a shutdown, which is the
            // same need with no one to click the button.
            shouldStop: () => closing() || task.cancelled,
            onProgress: ({ indexed, failed, total }) => {
              task.progress({
                done: indexed,
                total,
                detail: failed ? `${failed} could not be indexed` : null,
              });
              if (Date.now() - renewedAt < 20_000) return;
              renewedAt = Date.now();
              kv.renew('reindex', 'all', token, 60_000).catch(() => {});
            },
          });
          if (result.stopped) throw TroveError.internal('Reindex stopped before it finished');
          return result;
        },
      );
      // Released when the WORK ends, not when this function returns — it returns as
      // soon as the task exists, which is long before the rebuild is done.
      const done = begun.done.finally(() => kv.release('reindex', 'all', token).catch(() => {}));
      done.catch(() => {});
      return { task: begun.task, alreadyRunning: false, done };
    }
  };
  const startReindex = async (opts) => (await beginReindex(opts)).done;
  // Retrying an issue runs the same work as everything else, and reports it the same
  // way. The issue is not cleared here — it is cleared by the indexing that succeeds,
  // so a retry can't report success over a problem that is still there.
  issues.handle('reindex-all', () => startReindex({ reason: 'Retrying after a failed scan' }));
  // Reconcile a collection against what its store actually holds. Same three callers as
  // the reindex — scheduled, manual, and issue retry — through one verb.
  // Where a scan that ran out of time left off. Persisted, because the whole point is
  // that the next invocation — possibly in a different isolate, minutes later — picks
  // the bucket up rather than starting again.
  // SPIKE: scanning runs as an ngin engine — see engine/index.js. `beginScan`
  // keeps the signature it always had, so every caller and every test is
  // untouched, which is what makes the rewrite checkable rather than hopeful.
  const beginScan = scanStarter(engine);
  const startScan = async (collectionId, opts) => (await beginScan(collectionId, opts)).done;
  // Where a route's "start this" goes. Normally straight to the functions above — the
  // process serving the request is also the one that will do the work. On a runtime
  // where that is not true (Workers: an isolate can be discarded the moment the
  // response resolves), `config.background` points them at whatever owns the work
  // instead, and the routes are none the wiser.
  // Bound once the verbs exist. `config.background` is how a deployment says the
  // work runs somewhere else — the Workers adapter points it at a Durable Object
  // — and everything above this line is unaware either way.
  lifecycleState.background = {
    beginScan: config.background?.beginScan || beginScan,
    beginReindex: config.background?.beginReindex || beginReindex,
  };
  const routeBeginScan = lifecycleState.background.beginScan;
  const routeBeginReindex = lifecycleState.background.beginReindex;
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
        // NOT `sidecar.sweep?.()` — that name did not exist on SidecarService, and the
        // optional call turned "evict idle documents" into a no-op for the process's
        // whole lifetime. It exists now, and the `?.` is gone so a rename shows up.
        .then(() => sidecar.sweep())
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

  // Routes contributed by delivery channels — the endpoints a client uses to REGISTER
  // with one, of which a VAPID key and a push subscription are the obvious example.
  // Mounted here rather than declared in routes.js so the drive's API reflects what is
  // actually configured: no web push, no /api/push/*. Added after the core table, so a
  // channel cannot shadow a built-in route by claiming its path.
  for (const channel of notifications?.channels || []) {
    for (const route of channel.routes?.(routeHelpers) || []) {
      router.add(route.method, route.path, route.deps || [], route.handler);
    }
  }

  // Said at boot, because that is when someone is looking and can still fix it. The
  // alternative is discovering it from a client that can't sign in and a 401 that
  // doesn't say why.
  for (const w of auth.warnings || []) console.warn(`[trove] ${w}`);

  // MCP: the same drive, the same identity, spoken to by an agent instead of a browser.
  // Null when switched off, and then nothing below routes to it.
  const mcp = createMcpHandler({
    vfs, collections, identity, config, auth,
    // So an agent's tool call obtains the same authorized handles an HTTP route does.
    container: engine.container,
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

    // The installed-app identity, generated rather than served from a file so an
    // operator can put their own name on it (see manifest.js). Ahead of the assets for
    // the obvious reason and unauthenticated for the same reason as the icon: a browser
    // fetches it before anyone has signed in, and a 401 here just means the app cannot
    // be installed.
    if (url.pathname === MANIFEST_PATH) {
      return new Response(JSON.stringify(webManifest(config.manifest), null, 2), {
        status: 200,
        headers: {
          'content-type': 'application/manifest+json',
          // A stable name whose contents change with configuration — exactly the case
          // `immutable` must never be claimed for.
          'cache-control': cacheControlFor(url.pathname),
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
      //
      // A capability grant is resolved FIRST, and when one is found the identity step is
      // skipped entirely. That ordering is the design: an API key answers "what may this
      // request do" and deliberately does not answer "who is this", so there is no
      // principal to attach and nothing downstream can mistake a key for a person.
      //
      // Resolving both would be worse than useless. A request bearing a weak key and a
      // strong session would get the union of the two, which is the confused deputy
      // reached by being accommodating — so it is one or the other, never both.
      let principal = null;
      let grant = null;
      try {
        grant = await capabilities.resolve(req);
        if (!grant) principal = await identity.authenticate(req);
      } catch (err) {
        const e = err instanceof TroveError ? err : TroveError.unauthorized('Authentication failed');
        return withChallenge(new Response(JSON.stringify(e.toJSON()), { status: e.status, headers: { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' } }), req);
      }
      const res = await router.handle(req, {
        // Per-request, and nothing else: the resources a route needs come from
        // the container, by the names that route declared. Handing over `vfs`,
        // `plugins`, `kv`, `sqlite` and the rest to every handler was a service
        // locator — nothing recorded what a route used, so nothing stopped it
        // reaching for more.
        container: engine.container,
        config, principal, grant, auth, mcp,
      });
      // A route can refuse on its own (a token that verified but names nobody we know,
      // a session that expired between calls). Whatever refused, the answer to "so
      // where do I sign in" is the same one, so it is attached in one place rather
      // than at every throw site.
      return withChallenge(res, req);
    }
    if (config.assets) {
      const asset = await config.assets(req);
      if (asset) return hardenAsset(asset, config, req);
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
    lifecycleState.closing = true;
    await indexRebuild?.catch(() => {});
    if (maintenance) clearInterval(maintenance);
    if (scanTimer) clearInterval(scanTimer);
    // Everything else is the container's: it disposes in reverse construction
    // order, so each resource goes down before the ones it was built from. That
    // used to be a hand-written list here which had to agree with a build order
    // two hundred lines above it, and nothing checked that it did.
    await backbone.release();
    await engine.dispose();
  }

  /**
   * One slice of the periodic work, for a runtime with no timers.
   *
   * `setInterval` is how a long-lived process does this, and it is exactly wrong on
   * Cloudflare Workers: a timer registered inside a request does not survive the
   * request, so the maintenance and scan intervals below simply never fire there.
   * A Worker's answer is a Cron Trigger calling this, awaited inside the `scheduled`
   * handler so the runtime keeps the isolate alive until it settles.
   *
   * `budgetMs` bounds the scan slice — a bucket has no size limit and an invocation
   * does, so it does as much as it can and stores where it got to.
   */
  async function runMaintenance({ budgetMs = 20_000, scan = true } = {}) {
    const out = { swept: false, purged: 0, scans: [], notified: 0 };
    await vfs.uploads.sweepExpired(Date.now());
    await sidecar.sweep();
    // Mentions are batched and drained on an interval — a timer, and a timer registered
    // during a request does not outlive it on Workers, where the adapter switches the
    // flusher off for exactly that reason. Nothing else called flush, so on that runtime
    // mentions piled up in the pending store and were never delivered at all: no inbox
    // entry, no push, no error. Maintenance runs from a cron there, which is the one
    // thing that does fire. Harmless where the timer works — concurrent drains collapse.
    out.notified = await notifications.flush().catch((e) => {
      console.error('[trove] mention flush failed', e);
      return 0;
    });
    const trashMs = (config.trashRetentionDays ?? 30) * 86400_000;
    if (trashMs > 0) out.purged = (await vfs.purgeTrash({ before: Date.now() - trashMs }))?.purged || 0;
    out.swept = true;
    if (!scan) return out;
    const list = collections ? await collections.list(null).catch(() => []) : [];
    const targets = list.length ? list : [{ id: 'default' }];
    // Share the budget across collections so one huge bucket can't starve the rest.
    const each = Math.max(1000, Math.floor(budgetMs / targets.length));
    for (const c of targets) {
      const r = await startScan(c.id, { reason: 'Scheduled', deadlineMs: each }).catch((e) => ({ error: e.message }));
      out.scans.push({ collectionId: c.id, ...r });
    }
    return out;
  }

  return { vfs, handle, router, sidecar, notifications, identity, apiKeys, capabilities, kv, collections, plugins, sqlite: sqliteProvider, tasks, issues, indexRebuild,
    // The graph itself, so an action or query can be dispatched directly — by a
    // test, by MCP, by anything that is not an HTTP route.
    engine, engineContainer: engine.container,
    // `start*` always runs the work HERE — that is what maintenance and the alarm loop
    // inside a Durable Object want. `begin*` goes wherever `config.background` says,
    // which for a front-line Worker isolate is the object rather than itself.
    startScan, startReindex, beginScan: routeBeginScan, beginReindex: routeBeginReindex,
    runMaintenance, mcp, auth, close };
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
function hardenAsset(res, config = {}, req) {
  res.headers.set('x-content-type-options', 'nosniff');
  res.headers.set('x-frame-options', 'SAMEORIGIN');
  res.headers.set('referrer-policy', 'no-referrer');
  if (typeof config.csp === 'string') res.headers.set('content-security-policy', config.csp);

  // A floor, not an override. The Node and Bun file server already decides this per
  // request — it has to, because an index.html served as an SPA fallback must be
  // revalidated even though the file it came from could not be. What is left is the
  // Workers path, where assets come from a binding that applies Cloudflare's defaults
  // rather than the /assets/ convention this repository's build guarantees.
  if (req && !res.headers.has('cache-control')) {
    try {
      res.headers.set('cache-control', cacheControlFor(decodeURIComponent(new URL(req.url).pathname)));
    } catch { /* a path that will not decode names nothing worth caching */ }
  }
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

  // What the installed app calls itself. Every field is optional and every default
  // reproduces the document that used to be a static file, so a drive that sets none of
  // these is unchanged — see manifest.js.
  config.manifest = manifestFromEnv(env);

  // The MCP endpoint reads its own settings out of here (mcpConfigFromEnv), and this
  // was never populated — so `TROVE_MCP=off`, `TROVE_MCP_REQUIRE_AUTH=true`,
  // `TROVE_MCP_PATH` and `TROVE_MCP_RESOURCE` were all silently dead. An operator who
  // used the documented way to lock down or remove the agent endpoint still had it
  // live at /mcp, unauthenticated on a zero-config drive, with write_file and
  // delete_file on it. Carrying the environment forward is what makes those real.
  config.env = env;

  return config;
}

export { createRouter };
