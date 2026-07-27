// The Trove HTTP API, mapped onto Vfs methods. JSON in/out except downloads
// (bytes, range-aware) and direct part uploads (raw body). Downloads redirect to
// a presigned URL when the backend supports it, otherwise stream through here.

import { Router, json, parseRange } from './router.js';
import {
  TroveError, assertSafePluginSql, concatBytes, metadataUrl, publicOrigin,
} from '@trove/core';
import { parseContribUri, CORE_DOMAIN } from '@trove/core/plugins/identity.js';

const ENV = typeof process !== 'undefined' ? (process.env || {}) : {};
// Cap JSON request bodies so a giant payload can't exhaust server memory. Uploads
// don't use body() (their bytes stream straight to storage), so this is safe to keep small.
const MAX_JSON_BYTES = Number(ENV.TROVE_MAX_JSON_BYTES || 4 * 1024 * 1024);
// Clamp any client-supplied result limit to a sane ceiling (DoS via huge scans).
const MAX_PAGE = Number(ENV.TROVE_MAX_PAGE || 1000);

async function body(req) {
  const text = await readCapped(req, MAX_JSON_BYTES);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw TroveError.invalid('Body must be valid JSON');
  }
}

// Read the body as text, aborting if it exceeds `max` bytes (checks Content-Length
// first, then enforces while streaming in case the header lies or is absent).
async function readCapped(req, max) {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared && declared > max) throw TroveError.invalid('Request body too large');
  const reader = req.body?.getReader?.();
  if (!reader) {
    const text = await req.text();
    if (text.length > max) throw TroveError.invalid('Request body too large');
    return text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw TroveError.invalid('Request body too large'); }
    chunks.push(value);
  }
  return new TextDecoder().decode(concatBytes(chunks));
}
// Read a raw binary body (e.g. an uploaded plugin package), capped like readCapped —
// which means enforcing WHILE streaming, not after. Checking `.byteLength` on the result
// of `arrayBuffer()` is a check that happens once the whole body is already resident, so
// a chunked upload with no Content-Length could park 400 MB in the heap and only then be
// told it was too large.
async function readBytesCapped(req, max) {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared && declared > max) throw TroveError.invalid('Request body too large');
  const reader = req.body?.getReader?.();
  if (!reader) {
    const buf = new Uint8Array(await req.arrayBuffer());
    if (buf.byteLength > max) throw TroveError.invalid('Request body too large');
    return buf;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw TroveError.invalid('Request body too large'); }
    chunks.push(value);
  }
  return concatBytes(chunks);
}
function clampLimit(value, dflt) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.floor(n), MAX_PAGE);
}

// Content types safe to render inline in the app's own origin. Anything else
// (HTML, SVG, XML, scripts…) is forced to download so it can't execute as
// same-origin script when opened directly.
function inlineSafe(ct) {
  const t = String(ct || '').toLowerCase().split(';')[0].trim();
  if (t === 'image/svg+xml') return false;
  return /^image\//.test(t) || /^audio\//.test(t) || /^video\//.test(t) || t === 'application/pdf' || t === 'text/plain';
}

// Build a Content-Disposition header (RFC 6266).
//
// `filename` is a quoted-string, so a browser takes the bytes literally — percent-
// encoding it, which is what this used to do, is not a decoding any client performs.
// "Q3 report, final.pdf" arrived as "Q3%20report%2C%20final.pdf" and that is the name
// that landed on disk, for essentially every real filename. So: an ASCII fallback in
// `filename` (with the two characters that would break the quoting removed) and the
// real name in `filename*`, which IS percent-encoded by specification.
function contentDisposition(type, name) {
  const clean = String(name || 'download').replace(/[\\"]/g, '').replace(/[\x00-\x1f\x7f]/g, '');
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_') || 'download';
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

// Reject SSRF-prone hosts for the server-side assetlinks fetch: IP literals,
// loopback, link-local (cloud metadata), and internal TLDs. DNS names that resolve
// to private IPs are a residual (rebinding) risk, documented in the README.
function assertPublicHost(hostname) {
  // Normalise the way `fetch` will. This tested the RAW string against a dotted-quad
  // regex, but the WHATWG URL parser accepts `127.1`, `0x7f.0.0.1`, `0177.0.0.1` and
  // `2130706433` and turns them all into 127.0.0.1 — so anything that wasn't already
  // dotted-quad walked straight past the private-address check.
  let h;
  try {
    h = new URL(`https://${hostname}`).hostname.toLowerCase();
  } catch {
    throw TroveError.invalid('That is not a valid host');
  }
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    throw TroveError.invalid('Refusing to fetch from an internal host');
  }
  // IPv4 literal → block private/loopback/link-local ranges; block IPv6 literals wholesale.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || a >= 224) {
      throw TroveError.invalid('Refusing to fetch from a private address');
    }
  }
  if (h.includes(':') || h.startsWith('[')) throw TroveError.invalid('Refusing to fetch from an IP literal');
  return h;
}

// Which collection a request targets. There is no folder to infer one from any more,
// so it's named explicitly or it's the default.
function collectionOf(src) {
  return src?.collection || src?.collectionId || 'default';
}

export function createRouter() {
  const r = new Router();

  // Liveness: the process is up and serving.
  r.get('/api/health', [], () => ({ ok: true, service: 'trove', time: Date.now() }));

  // Readiness: the backing store actually answers — for load-balancer / k8s gating.
  r.get('/api/ready', ['sqlite'], async ({ sqlite }) => {
    try {
      if (sqlite) { const db = await sqlite.obtain({ key: 'metadata' }); await db.get('SELECT 1'); }
      return { ok: true };
    } catch (err) {
      throw TroveError.transient('Storage not ready', { cause: err });
    }
  });

  r.get('/api/capabilities', ['auth', 'collections', 'notifications', 'sidecar', 'vfs'], async (ctx) => {
    const { vfs, config, sidecar, notifications, principal, query, auth, mcp } = ctx;
    // Storage is per-collection, so report the backend for the requested collection
    // (else the client picks the wrong upload strategy on a non-default collection).
    let storage = vfs.storage;
    if (query.collection) {
      await assertCap(ctx, query.collection, 'read');
      storage = await vfs.storageFor(query.collection);
    }
    return {
      collection: query.collection || 'default',
      storage: storage.capabilities,
      indexers: vfs.indexers.list(),
      partSize: vfs.uploads.partSize,
      features: {
        semanticSearch: !!vfs.search,
        conversations: !!sidecar,
        notifications: !!notifications,
        webPush: !!notifications?.vapidPublicKey(),
        auth: !!principal && !principal.anonymous,
      },
      principal: principal || null,
      search: vfs.search ? vfs.search.describe() : null,
      // What this deployment's search box actually accepts. The transformer owns the
      // grammar, so it owns the prompt — a client that hardcodes "# filter by tag"
      // tells people the wrong thing the moment a different transformer is configured.
      searchPrompt: vfs.searchTransformer?.describe?.() || null,

      // Where a refused client is sent, and where an agent connects. Both are DEPLOYMENT
      // facts — env, or a field the library caller passed — so they are reported here
      // rather than made editable: pointing the drive at a different authorization
      // server changes who can reach every file in it, which is a deploy-time decision,
      // not a preference.
      auth: {
        authorizationServers: auth?.authorizationServers || [],
        // Which of TROVE_AUTH_SERVER / TROVE_JWT_ISSUER the value came from, or 'none'.
        // "We inferred this from your issuer" is a different fact from "you set this",
        // and someone debugging a mismatch needs to know which.
        source: auth?.source || 'none',
        metadataUrl: metadataUrl(publicOrigin(ctx.req, config)),
      },
      mcp: mcp ? {
        enabled: true,
        endpoint: mcp.endpoint(ctx.req),
        metadataUrl: metadataUrl(mcp.endpoint(ctx.req)),
        requiresAuth: mcp.requiresAuth(),
        // The one state that makes the endpoint unusable while looking configured: a
        // token is required and there is nowhere to go and get one. Named as a problem
        // rather than left to be inferred from an empty array.
        needsAuthorizationServer: mcp.requiresAuth() && !(auth?.authorizationServers || []).length,
      } : { enabled: false },

      ...(config?.clientConfig || {}),
    };
  });

  // --- collections -----------------------------------------------------------

  r.get('/api/collections', ['collections'], async ({ collections, principal }) => {
    if (!collections) return { collections: [{ id: 'default', name: 'My Drive', capabilities: ['read', 'write', 'delete', 'admin'] }] };
    return { collections: await collections.list(principal), canCreate: collections.canCreate(principal) };
  });

  r.get('/api/collections/:id', ['collections'], async ({ collections, principal, params }) => {
    if (!collections) return { collection: { id: 'default', name: 'My Drive' } };
    const c = await collections.assert(principal, params.id, 'read');
    return { collection: collections.describe(c, principal) };
  });

  r.post('/api/collections', ['collections'], async ({ collections, principal, req }) => {
    if (!collections) throw TroveError.unsupported('Collections are not enabled');
    const b = await body(req);
    return { collection: await collections.create(b, principal) };
  });

  r.post('/api/collections/:id', ['collections'], async ({ collections, principal, params, req }) => {
    if (!collections) throw TroveError.unsupported('Collections are not enabled');
    const b = await body(req);
    return { collection: await collections.update(params.id, b, principal) };
  });

  r.delete('/api/collections/:id', ['collections', 'vfs'], async ({ collections, vfs, principal, params }) => {
    if (!collections) throw TroveError.unsupported('Collections are not enabled');
    // A collection record is the only thing that knows where its items' BYTES live, so
    // deleting it while items still reference it stranded every one of them: `storageFor`
    // throws "Collection not found", and since reindex walks the whole metadata store,
    // every rebuild — including the one at boot — failed on them forever, raising a
    // retryable issue whose Retry re-ran the same failure. Refuse, and say what to do.
    const n = await vfs.metadata.countItems?.(params.id);
    if (n) {
      throw TroveError.conflict(
        `“${params.id}” still holds ${n.toLocaleString()} item${n === 1 ? '' : 's'}. `
        + 'Move or delete them first — removing the collection would leave them with no '
        + 'store to read their bytes from.',
        { details: { collectionId: params.id, items: n } },
      );
    }
    return collections.remove(params.id, principal);
  });

  r.post('/api/collections/:id/grants', ['collections'], async ({ collections, principal, params, req }) => {
    if (!collections) throw TroveError.unsupported('Collections are not enabled');
    const b = await body(req);
    return { collection: await collections.setGrant(params.id, b, principal) };
  });

  // --- browse ----------------------------------------------------------------

  // --- items -----------------------------------------------------------------
  // One noun: there is no filesystem and no folders, so everything addressable is an
  // item in a collection. Collection-level verbs sit at `/api/items/<verb>` and
  // item-scoped ones at `/api/items/:id/…`. The router matches in registration order,
  // so these literal routes must stay ABOVE any same-length `:id` route added later.

  // Every item in a collection. There is nothing to descend into — a drive is browsed
  // by search and by following links, and this is the "show me everything" fallback.
  r.get('/api/items', ['collections', 'vfs'], async (ctx) => {
    const { vfs, query } = ctx;
    const collectionId = collectionOf(query);
    await assertCap(ctx, collectionId, 'read');
    const { items, nextCursor } = await vfs.list(collectionId, {
      sort: query.sort, order: query.order,
      limit: clampLimit(query.limit, 500),
      cursor: query.cursor,
    });
    // `stats` describes the COLLECTION; `items` is one page of it. Without this the
    // client can only report the page it happens to be holding, which on a drive with
    // more items than fit in a page is simply a wrong number on screen.
    const stats = await vfs.metadata.collectionStats?.(collectionId).catch(() => null) ?? null;
    // Space left on the backing store, when it can say. Null for object stores, which
    // have no such number — and a UI that showed a made-up gauge for S3 would be worse
    // than one that shows nothing.
    const usage = await vfs.storageUsage(collectionId).catch(() => null);
    return { items, nextCursor, collectionId, stats, usage };
  });

  // Resolve an item: by id, by `?name=` within a collection, or by a `trove:` URI.
  r.get('/api/items/resolve', ['collections', 'vfs'], async (ctx) => {
    const { query } = ctx;
    const ref = query.id || query.uri || query.name;
    if (!ref) throw TroveError.invalid('id, name or uri is required');
    const node = await ctx.vfs.stat(ref, collectionOf(query));
    await assertCap(ctx, node.collectionId, 'read');
    return { node };
  });

  // What links to this item — the inverse of the links its own content declares, and
  // what replaces "which folder is it in?".
  r.get('/api/items/backlinks', ['collections', 'vfs'], async (ctx) => {
    const node = await nodeWithCap(ctx, ctx.query.id, 'read');
    // Scoped in the query, not filtered after: backlinks cross collections, so a limit
    // spent on unreadable rows would report "nothing links here" while something the
    // caller can see sits just past the cut.
    const items = await ctx.vfs.backlinks(node.id, {
      limit: clampLimit(ctx.query.limit, 100),
      collectionIds: await readableCollectionIds(ctx),
    });
    return { items };
  });

  r.post('/api/items/rename', ['collections', 'vfs'], async (ctx) => {
    const b = await body(ctx.req);
    if (!b.id || !b.newName) throw TroveError.invalid('id and newName are required');
    const node = await ctx.vfs.stat(b.id);
    await assertCap(ctx, node.collectionId, 'write');
    return { node: await ctx.vfs.rename(b.id, b.newName) };
  });

  r.post('/api/items/delete', ['collections', 'vfs'], async (ctx) => {
    const b = await body(ctx.req);
    if (!b.id) throw TroveError.invalid('id is required');
    const node = await ctx.vfs.stat(b.id);
    await assertCap(ctx, node.collectionId, 'delete');
    return ctx.vfs.remove(b.id);
  });

  // --- download (presign redirect or range-aware proxy) ----------------------

  r.get('/api/items/download', ['collections', 'vfs'], async (ctx) => {
    const { vfs, query, req } = ctx;
    const id = query.id;
    if (!id) throw TroveError.invalid('id is required');
    const node = await nodeWithCap(ctx, id, 'read');
    const ct = node.contentType || 'application/octet-stream';
    // Force a download for anything not safe to render inline in our own origin
    // (HTML/SVG/etc. would otherwise be same-origin XSS when opened directly).
    const attach = query.disposition === 'attachment' || !inlineSafe(ct);
    const range = parseRange(req.headers.get('range'));

    // Ranged requests must proxy (we can't add Range to a bare redirect safely
    // for all clients), so only redirect for full-file GETs.
    if (!range) {
      const d = await vfs.getDownload(id, { download: attach });
      if (d.mode === 'redirect') return Response.redirect(d.url, 302);
    }

    const { stream, size, contentType, etag, range: served } = await vfs.readStream(id, { range });
    const headers = {
      'content-type': contentType || ct,
      'accept-ranges': 'bytes',
      'content-length': String(size),
      'x-content-type-options': 'nosniff',
      ...(etag ? { etag } : {}),
      'content-disposition': contentDisposition(attach ? 'attachment' : 'inline', node.name),
      'cache-control': 'private, max-age=0',
    };
    if (served) {
      headers['content-range'] = `bytes ${served.start}-${served.end}/${served.total}`;
      return new Response(stream, { status: 206, headers });
    }
    return new Response(stream, { status: 200, headers });
  });

  // --- uploads ---------------------------------------------------------------

  r.post('/api/uploads', ['collections', 'vfs'], async (ctx) => {
    const b = await body(ctx.req);
    if (!b.name) throw TroveError.invalid('name is required');
    const collectionId = collectionOf(b);
    await assertCap(ctx, collectionId, 'write');
    const plan = await ctx.vfs.createUpload({
      collectionId, name: b.name, size: Number(b.size ?? 0), contentType: b.contentType,
      overwrite: b.overwrite === true,
    });
    return uploadDescriptor(plan);
  });

  r.get('/api/uploads/:id/status', ['collections', 'vfs'], async (ctx) => {
    await assertUploadCap(ctx, ctx.params.id, 'write');
    return ctx.vfs.uploadStatus(ctx.params.id);
  });

  r.post('/api/uploads/:id/parts/:n/sign', ['collections', 'vfs'], async (ctx) => {
    await assertUploadCap(ctx, ctx.params.id, 'write');
    return { url: await ctx.vfs.signUploadPart(ctx.params.id, Number(ctx.params.n)) };
  });

  r.post('/api/uploads/:id/parts/:n/report', ['collections', 'vfs'], async (ctx) => {
    await assertUploadCap(ctx, ctx.params.id, 'write');
    const b = await body(ctx.req);
    return ctx.vfs.reportUploadPart(ctx.params.id, Number(ctx.params.n), b.etag);
  });

  // Direct part upload — raw body streamed to storage.
  r.put('/api/uploads/:id/parts/:n', ['collections', 'vfs'], async (ctx) => {
    await assertUploadCap(ctx, ctx.params.id, 'write');
    const res = await ctx.vfs.uploadPart(ctx.params.id, Number(ctx.params.n), ctx.req.body ?? new Uint8Array(0));
    return json(res);
  });

  r.post('/api/uploads/:id/complete', ['collections', 'vfs'], async (ctx) => {
    await assertUploadCap(ctx, ctx.params.id, 'write');
    const b = await body(ctx.req);
    return { node: await ctx.vfs.completeUpload(ctx.params.id, b.parts) };
  });

  r.delete('/api/uploads/:id', ['collections', 'vfs'], async (ctx) => {
    await assertUploadCap(ctx, ctx.params.id, 'write');
    await ctx.vfs.abortUpload(ctx.params.id);
    return { ok: true };
  });

  // --- search & indexing -----------------------------------------------------

  r.get('/api/search', ['collections', 'vfs'], async (ctx) => {
    const { vfs, query } = ctx;
    if (!query.q) throw TroveError.invalid('q is required');
    const collectionIds = await readableCollectionIds(ctx, query.collection);
    const results = await vfs.searchQuery(query.q, {
      mode: query.mode, limit: clampLimit(query.limit, 40),
      indexers: query.indexers ? query.indexers.split(',') : undefined,
      collectionIds,
    });
    return { query: query.q, results };
  });

  // Unified query: a raw user string is run through the search transformer (default
  // parses `#tag` syntax; a plugged-in one may use an LLM), then dispatched. Returns
  // the results AND the `resolved` query (what was actually searched) so the client
  // can honestly show it.
  r.post('/api/query', ['collections', 'vfs'], async (ctx) => {
    const b = await body(ctx.req);
    if (typeof b.q !== 'string' || !b.q.trim()) throw TroveError.invalid('q is required');
    const collectionIds = await readableCollectionIds(ctx, b.collection);
    const { results, resolved } = await ctx.vfs.query(b.q, {
      mode: b.mode, limit: clampLimit(b.limit, 40), collectionIds,
    });
    return { query: b.q, results, resolved };
  });

  // Drive-wide tag/property filter (the launcher's `#tag` / `#key:op:value`).
  r.post('/api/tags/search', ['collections', 'vfs'], async (ctx) => {
    const b = await body(ctx.req);
    const filters = Array.isArray(b.filters) ? b.filters : [];
    const collectionIds = await readableCollectionIds(ctx, b.collection);
    const items = await ctx.vfs.findByTags(filters, {
      q: b.q, collectionIds, limit: clampLimit(b.limit, 100),
    });
    return { items };
  });

  r.get('/api/indexers', ['vfs'], ({ vfs }) => ({ indexers: vfs.indexers.list() }));

  // Plugin indexers push a namespaced contribution here (semanticTexts / tags /
  // metadata; legacy documents/facet accepted). The namespace is the path param,
  // so a plugin can only ever write under its own id.
  // Push a contribution under a contributor namespace. TWO gates, because they answer
  // different questions: `write` on the collection says you may change this item at
  // all, and namespace ownership says you may speak AS this contributor. Without the
  // second, anyone who can write anywhere could overwrite `core.links` and quietly
  // break every backlink, or impersonate another plugin's index.
  r.post('/api/index/:indexerId', ['collections', 'plugins', 'vfs'], async (ctx) => {
    const b = await body(ctx.req);
    if (!b.nodeId) throw TroveError.invalid('nodeId is required');
    await assertContributorOwned(ctx, ctx.params.indexerId);
    await assertCap(ctx, (await ctx.vfs.stat(b.nodeId)).collectionId, 'write');
    return ctx.vfs.indexContributions(b.nodeId, ctx.params.indexerId, {
      semanticTexts: b.semanticTexts, tags: b.tags, metadata: b.metadata,
      documents: b.documents, facet: b.facet, // legacy
    });
  });

  // --- background work, and problems that outlived it ------------------------
  //
  // Two endpoints that look similar and mean different things. `/api/tasks` is work
  // happening NOW — it is in memory, it is gone when the server restarts, and that is
  // correct, because the work is gone too. `/api/issues` is what a failure LEFT BEHIND:
  // durable, because a file that failed to index is still unindexed tomorrow.
  //
  // Both are polled rather than streamed. There is no streaming transport anywhere in
  // this server yet, and adding one for a progress bar would mean SSE plumbing through
  // three adapters; the client polls fast only while something is running and goes
  // silent otherwise, which costs nothing at rest.

  // Every call through `ctx.tasks` is awaited. In a single long-lived process the
  // registry is a local object and these resolve immediately; where the work runs
  // somewhere else — a Durable Object, because a Worker isolate cannot own work that
  // outlives a request — the same calls cross a boundary. Awaiting costs nothing in
  // the first case and is the difference between working and not in the second.

  r.get('/api/tasks', ['collections', 'tasks'], async (ctx) => {
    const collectionIds = await readableCollectionIds(ctx);
    return {
      tasks: await ctx.tasks.list({
        collectionIds,
        // A drive-wide task (a full reindex) names no collection, so scoping can't
        // place it — only someone who can act on the whole drive is shown one.
        includeGlobal: await canWholeDrive(ctx),
      }),
    };
  });

  r.post('/api/tasks/:id/cancel', ['collections', 'tasks'], async (ctx) => {
    await assertTaskAccess(ctx, await ctx.tasks.get(ctx.params.id), 'cancel');
    return { cancelled: await ctx.tasks.cancel(ctx.params.id) };
  });

  r.delete('/api/tasks/:id', ['collections', 'tasks'], async (ctx) => {
    await assertTaskAccess(ctx, await ctx.tasks.get(ctx.params.id), 'dismiss');
    await ctx.tasks.dismiss(ctx.params.id);
    return { ok: true };
  });

  r.get('/api/issues', ['collections', 'issues'], async (ctx) => {
    const collectionIds = await readableCollectionIds(ctx);
    const admin = await canWholeDrive(ctx);
    const issues = await ctx.issues.list({ collectionIds, includeGlobal: admin });
    // `retryable` is computed here, not stored: whether a fix can be attempted depends
    // on which handlers this deployment registered, and the client should offer a Retry
    // button only when pressing it will do something.
    return { issues: issues.map((i) => ({ ...i, retryable: ctx.issues.canRetry(i) })) };
  });

  // Retrying starts a task and returns it immediately — the fix may take minutes, and
  // holding the request open for it would just time out. The issue is NOT cleared here;
  // it clears when the work actually succeeds.
  r.post('/api/issues/:id/retry', ['collections', 'issues', 'tasks'], async (ctx) => {
    const issue = await ctx.issues.get(ctx.params.id);
    if (!issue) throw TroveError.notFound('Issue');
    await assertIssueAccess(ctx, issue, 'write');
    const started = ctx.issues.retry(ctx.params.id);
    started.catch(() => {}); // the task record carries the failure; don't reject globally
    // Hand back the task list so the client can adopt the new task without a round trip.
    // Scoped exactly like GET /api/tasks — a task title names the file it is working on,
    // so being allowed to retry one issue must not hand back the drive-wide list.
    return {
      ok: true,
      tasks: ctx.tasks.list({
        collectionIds: await readableCollectionIds(ctx),
        includeGlobal: await canWholeDrive(ctx),
      }),
    };
  });

  // Dismissing is not fixing. Allowed because a problem can become irrelevant (the file
  // was deleted, the plugin uninstalled) and a list you can't clear stops being read —
  // but if the underlying failure recurs, it comes straight back.
  r.delete('/api/issues/:id', ['collections', 'issues'], async (ctx) => {
    const issue = await ctx.issues.get(ctx.params.id);
    if (!issue) return { ok: true };
    await assertIssueAccess(ctx, issue, 'write');
    await ctx.issues.remove(ctx.params.id);
    return { ok: true };
  });

  // Rebuild the search index on demand. Admin-only: it re-reads every object in the
  // drive, so it is a real load, and it is drive-wide rather than scoped to anything
  // the caller owns. Returns the task, which is how the caller watches it.
  r.post('/api/reindex', ['collections', 'tasks'], async (ctx) => {
    await requireWholeDrive(ctx, 'rebuild the search index');
    if (!ctx.beginReindex) throw TroveError.unsupported('Reindexing is not available on this deployment');
    // Two concurrent full rebuilds would double the work to reach the same place, so
    // `beginReindex` claims the drive first and says whether it got it. The claim is
    // shared state rather than this process's task list — the other rebuild may be in
    // another isolate, and a check that can only see local memory would not find it.
    const { task, alreadyRunning } = await ctx.beginReindex({ reason: 'Started manually' });
    if (alreadyRunning) {
      const local = (await ctx.tasks.list()).find((t) => t.kind === 'index' && t.status === 'running');
      return { task: local || null, alreadyRunning: true };
    }
    return { task };
  });

  // --- trash -----------------------------------------------------------------
  // Deleting moves an item here rather than destroying it. Everything below needs
  // `delete` on the collection, the same capability the delete itself needed — seeing
  // what you deleted, and undoing it, are not lesser rights than deleting.

  r.get('/api/trash', ['collections', 'vfs'], async (ctx) => {
    const collectionId = collectionOf(ctx.query);
    await assertCap(ctx, collectionId, 'delete');
    return { items: await ctx.vfs.listTrash(collectionId, { limit: clampLimit(ctx.query.limit, 200) }), collectionId };
  });

  r.post('/api/trash/restore', ['collections', 'vfs'], async (ctx) => {
    const b = await body(ctx.req);
    if (!b.id) throw TroveError.invalid('id is required');
    const node = await ctx.vfs.metadata.getById(b.id);
    if (!node) throw TroveError.notFound('Item');
    await assertCap(ctx, node.collectionId, 'delete');
    return { node: await ctx.vfs.restore(b.id) };
  });

  // Destroy for real. Separate from DELETE /api/items so that emptying the trash can
  // never be something you reach by accident from the ordinary delete path.
  r.post('/api/trash/purge', ['collections', 'vfs'], async (ctx) => {
    const b = await body(ctx.req);
    if (b.id) {
      const node = await ctx.vfs.metadata.getById(b.id);
      if (!node) throw TroveError.notFound('Item');
      await assertCap(ctx, node.collectionId, 'delete');
      await ctx.vfs.remove(b.id, { permanent: true });
      return { purged: 1 };
    }
    const collectionId = collectionOf(b);
    await assertCap(ctx, collectionId, 'delete');
    const trash = await ctx.vfs.listTrash(collectionId, { limit: MAX_PAGE });
    let purged = 0;
    for (const node of trash) {
      await ctx.vfs.remove(node.id, { permanent: true }).then(() => { purged++; }).catch(() => {});
    }
    return { purged };
  });

  // Reconcile a collection against the bytes actually in its store — how files added,
  // replaced, or removed by anything other than Trove get noticed. Needs `write` on the
  // collection, because a scan can create items in it.
  r.post('/api/collections/:id/scan', ['collections', 'tasks'], async (ctx) => {
    await assertCap(ctx, ctx.params.id, 'write');
    if (!ctx.beginScan) throw TroveError.unsupported('Scanning is not available on this deployment');
    const { task, alreadyRunning } = await ctx.beginScan(ctx.params.id, { reason: 'Started manually' });
    if (alreadyRunning) {
      const local = (await ctx.tasks.list())
        .find((t) => t.kind === 'scan' && t.collectionId === ctx.params.id && t.status === 'running');
      return { task: local || null, alreadyRunning: true };
    }
    return { task };
  });

  // --- identity --------------------------------------------------------------

  r.get('/api/me', ['collections'], ({ principal, collections }) => ({
    principal: principal || null,
    // Authenticated means SOMEONE signed in — not merely that a principal object
    // exists. The shared anonymous user is a stand-in for "no identity configured", and
    // reporting it as authenticated would have the client show a profile for nobody.
    authenticated: !!principal && !principal.anonymous,
    admin: collections ? collections.isAdmin(principal) : !!principal,
  }));

  // --- conversations, tags, sidecar (per file) -------------------------------
  // The :id is a file node id; the sidecar is that file's CRDT document.

  r.get('/api/items/:id/sidecar', ['collections', 'sidecar', 'vfs'], async (ctx) => {
    requireSidecar(ctx.sidecar);
    await nodeWithCap(ctx, ctx.params.id, 'read'); // 404 if the file is gone
    return ctx.sidecar.view(ctx.params.id);
  });

  r.post('/api/items/:id/comments', ['collections', 'sidecar', 'vfs'], async (ctx) => {
    requireSidecar(ctx.sidecar);
    requirePrincipal(ctx.principal);
    await nodeWithCap(ctx, ctx.params.id, 'write');
    const b = await body(ctx.req);
    return { comment: await ctx.sidecar.addComment(ctx.params.id, { body: b.body, parentId: b.parentId, mentions: b.mentions }, ctx.principal) };
  });

  r.post('/api/items/:id/comments/:cid/edit', ['collections', 'sidecar', 'vfs'], async (ctx) => {
    requireSidecar(ctx.sidecar);
    requirePrincipal(ctx.principal);
    await nodeWithCap(ctx, ctx.params.id, 'write'); // + authorship checked in the service
    const b = await body(ctx.req);
    return { comment: await ctx.sidecar.editComment(ctx.params.id, ctx.params.cid, b.body, ctx.principal) };
  });

  r.delete('/api/items/:id/comments/:cid', ['collections', 'sidecar', 'vfs'], async (ctx) => {
    requireSidecar(ctx.sidecar);
    requirePrincipal(ctx.principal);
    await nodeWithCap(ctx, ctx.params.id, 'write'); // + authorship checked in the service
    return ctx.sidecar.deleteComment(ctx.params.id, ctx.params.cid, ctx.principal);
  });

  r.post('/api/items/:id/comments/:cid/react', ['collections', 'sidecar', 'vfs'], async (ctx) => {
    requireSidecar(ctx.sidecar);
    requirePrincipal(ctx.principal);
    await nodeWithCap(ctx, ctx.params.id, 'write');
    const b = await body(ctx.req);
    if (!b.emoji) throw TroveError.invalid('emoji is required');
    return { comment: await ctx.sidecar.react(ctx.params.id, ctx.params.cid, b.emoji, b.on !== false, ctx.principal) };
  });

  r.post('/api/items/:id/tags', ['collections', 'sidecar', 'vfs'], async (ctx) => {
    requireSidecar(ctx.sidecar);
    await nodeWithCap(ctx, ctx.params.id, 'write');
    const b = await body(ctx.req);
    if (!b.name) throw TroveError.invalid('name is required');
    // The façade sets the CRDT tag AND its queryable mirror together (no swallow).
    return ctx.vfs.setTag(ctx.params.id, b.name, b.value, ctx.principal);
  });

  r.delete('/api/items/:id/tags/:name', ['collections', 'sidecar', 'vfs'], async (ctx) => {
    requireSidecar(ctx.sidecar);
    // Removing a tag is a write — enforce the same per-collection ACL as adding one,
    // or a read-only user could strip tags off files they can't modify.
    await nodeWithCap(ctx, ctx.params.id, 'write');
    return ctx.vfs.removeTag(ctx.params.id, ctx.params.name, ctx.principal);
  });

  r.post('/api/items/:id/subscribe', ['collections', 'sidecar', 'vfs'], async (ctx) => {
    requireSidecar(ctx.sidecar);
    requirePrincipal(ctx.principal);
    await nodeWithCap(ctx, ctx.params.id, 'read');
    const b = await body(ctx.req);
    return ctx.sidecar.subscribe(ctx.params.id, ctx.principal, !!b.muted);
  });
  r.delete('/api/items/:id/subscribe', ['collections', 'sidecar', 'vfs'], async (ctx) => {
    requireSidecar(ctx.sidecar);
    requirePrincipal(ctx.principal);
    await nodeWithCap(ctx, ctx.params.id, 'read');
    return ctx.sidecar.unsubscribe(ctx.params.id, ctx.principal);
  });

  // --- notifications & web push ----------------------------------------------

  r.get('/api/notifications', ['notifications'], async ({ notifications, principal }) => {
    requireNotifications(notifications);
    requirePrincipal(principal);
    return notifications.inbox(principal.id);
  });
  r.post('/api/notifications/read', ['notifications'], async ({ notifications, principal, req }) => {
    requireNotifications(notifications);
    requirePrincipal(principal);
    const b = await body(req);
    return notifications.markRead(principal.id, b.ids);
  });

  r.get('/api/push/vapid', ['notifications'], ({ notifications }) => ({ publicKey: notifications?.vapidPublicKey() || null }));

  r.post('/api/push/subscribe', ['notifications'], async ({ notifications, principal, req }) => {
    requireNotifications(notifications);
    requirePrincipal(principal);
    const b = await body(req);
    return notifications.subscribePush(principal.id, b.subscription);
  });
  r.delete('/api/push/subscribe', ['notifications'], async ({ notifications, principal, req }) => {
    requireNotifications(notifications);
    requirePrincipal(principal);
    const b = await body(req);
    return notifications.unsubscribePush(principal.id, b.endpoint);
  });

  // --- plugins: domain verification proxy + per-plugin server storage --------

  // Fetch a plugin domain's assetlinks doc server-side (avoids browser CORS).
  r.get('/api/plugins/assetlinks', [], async ({ query, principal }) => {
    requirePrincipal(principal); // don't expose an open fetch proxy to the world
    const domain = String(query.domain || '');
    if (!/^[a-z0-9.-]+$/i.test(domain) || !domain.includes('.')) throw TroveError.invalid('Invalid domain');
    assertPublicHost(domain); // block loopback / private / metadata targets
    const url = `https://${domain}/.well-known/trove-assetlinks.json`;
    try {
      // No redirects: a public host must not bounce us onto an internal target.
      const res = await fetch(url, { redirect: 'error' });
      if (!res.ok) return { assetlinks: null };
      const body = await readCapped(res, 256 * 1024); // small, well-known doc
      return { assetlinks: JSON.parse(body) };
    } catch {
      return { assetlinks: null };
    }
  });

  // --- server-installed plugins: package store + install records --------------
  // Account-scoped plugins upload their full package to the server (blob → pluggable
  // PackageStore, record → SQLite) so they sync across the user's devices, the server
  // can enforce their capabilities, and removal cleans up. Device-only plugins never
  // touch these routes.

  // Install: upload the raw package zip; grants via ?grants=files,storage. The server
  // re-parses + validates and gates on scope (admin for server indexers / shared
  // resources), then stores the blob (deduped by digest) + the install record.
  r.post('/api/plugins/install', ['plugins'], async ({ plugins, principal, req, query }) => {
    requirePlugins(plugins);
    requirePrincipal(principal);
    const bytes = await readBytesCapped(req, plugins.maxPackageBytes || 32 * 1024 * 1024);
    const grants = query.grants ? String(query.grants).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    return { install: await plugins.install({ principal, bytes, grants }) };
  });

  // List this account's server-installed plugins (for cross-device sync).
  r.get('/api/plugins/installed', ['plugins'], async ({ plugins, principal }) => {
    requirePlugins(plugins);
    requirePrincipal(principal);
    return { plugins: await plugins.list(principal) };
  });

  // Download a plugin's package blob so another device can enable it locally.
  r.get('/api/plugins/:pluginId/package', ['plugins'], async ({ plugins, principal, params }) => {
    requirePlugins(plugins);
    requirePrincipal(principal);
    const { stream, size } = await plugins.getPackage(principal, params.pluginId);
    return new Response(stream, { status: 200, headers: {
      'content-type': 'application/zip', 'content-length': String(size),
      'content-disposition': `attachment; filename="${encodeURIComponent(params.pluginId)}.zip"`,
      'x-content-type-options': 'nosniff',
    } });
  });

  // Account uninstall: drop the record + blob, then wipe the plugin-private store.
  r.delete('/api/plugins/:pluginId/install', ['plugins', 'sqlite'], async ({ plugins, sqlite, principal, params }) => {
    requirePlugins(plugins);
    requirePrincipal(principal);
    const res = await plugins.remove(principal, params.pluginId);
    if (sqlite) await sqlite.drop({ key: `pstore:${principal.id}:plg:${params.pluginId}` }).catch(() => {});
    return res;
  });

  // Server-backed plugin storage: an isolated SQLite database per scope, keyed by
  // (user, plugin) for the private scope or (user, verified domain) for the shared
  // scope, so ownership is tracked and it can be wiped on uninstall. The sandboxed
  // plugin reaches this only through the host (which sets `scope`/`domain` from the
  // install record); we scope by the authenticated principal for cross-user
  // isolation, and only expose a fixed set of SQL ops against that one scoped db.
  const PLUGIN_SQL_OPS = new Set(['exec', 'run', 'get', 'all', 'batch']);
  const storeKey = (principal, pluginId, scope, domain) =>
    scope === 'domain'
      ? `pstore:${principal.id}:dom:${domain}`
      : `pstore:${principal.id}:plg:${pluginId}`;

  /**
   * A plugin may only open the DOMAIN store of its own domain.
   *
   * A plugin id is `<domain>/<name>`, so the domain it is entitled to is not something
   * the caller needs to tell us — and letting them tell us meant naming any domain and
   * reading another vendor's shared store outright.
   */
  const assertOwnDomain = (pluginId, domain) => {
    const own = String(pluginId || '').split('/')[0];
    if (!own || own !== domain) {
      throw TroveError.forbidden(`"${pluginId}" may only use the domain store for "${own || '(none)'}"`);
    }
  };

  r.post('/api/plugins/:pluginId/sql', ['plugins', 'sqlite'], async ({ sqlite, plugins, principal, params, req }) => {
    requirePluginStore(sqlite, principal);
    // Authoritative capability check when the plugin is server-installed (transitional:
    // allowed if there's no install record — device plugins predate this).
    if (plugins) await plugins.assertCapability(principal, params.pluginId, 'storage');
    const { scope = 'plugin', op, sql, params: args = [], statements, domain } = await body(req);
    if (!PLUGIN_SQL_OPS.has(op)) throw TroveError.invalid(`Unknown storage op "${op}"`);
    if (scope !== 'plugin' && scope !== 'domain') throw TroveError.invalid(`Unknown storage scope "${scope}"`);
    if (scope === 'domain' && !domain) throw TroveError.invalid('domain scope requires a domain');
    // The domain store is SHARED across a vendor's plugins, so opening it is a claim to
    // be one of them — and `pluginId` comes from the caller. `assertOwnDomain` ties the
    // two together but both are the caller's words; the install record is what makes
    // either mean anything. (The plugin-private scope needs no such check: its key is
    // already scoped to this principal, so the worst it reaches is their own data.)
    if (scope === 'domain') {
      assertOwnDomain(params.pluginId, domain);
      // Installed AND approved for the shared scope — the two are different questions,
      // and only the second is the one an administrator was asked about.
      if (plugins) await plugins.assertSharedStorage(principal, params.pluginId);
    }
    const db = await sqlite.obtain({ key: storeKey(principal, params.pluginId, scope, domain) });
    return { result: await runPluginSql(db, op, { sql, args, statements }) };
  });

  // Uninstall cleanup: wipe the plugin-private scope. The domain scope is shared
  // across a vendor's plugins and deliberately outlives any single uninstall.
  r.delete('/api/plugins/:pluginId/data', ['plugins', 'sqlite'], async ({ sqlite, plugins, principal, params }) => {
    requirePluginStore(sqlite, principal);
    // Same gate as the /sql route. Without it this was destroy-any-plugin's-data for
    // anyone who could reach the app origin — the one route in the pair that checked
    // nothing at all.
    if (plugins) await plugins.assertCapability(principal, params.pluginId, 'storage');
    await sqlite.drop({ key: storeKey(principal, params.pluginId, 'plugin') });
    return { ok: true };
  });

  return r;
}

async function runPluginSql(db, op, { sql, args, statements }) {
  const params = Array.isArray(args) ? args : [];
  switch (op) {
    case 'exec': assertSafePluginSql(sql); await db.exec(sql); return { ok: true };
    case 'run': assertSafePluginSql(sql); return db.run(sql, ...params);
    case 'get': assertSafePluginSql(sql); return db.get(sql, ...params);
    case 'all': assertSafePluginSql(sql); return db.all(sql, ...params);
    case 'batch': {
      const stmts = (Array.isArray(statements) ? statements : []).map((s) => {
        assertSafePluginSql(s?.sql);
        return { sql: s.sql, params: Array.isArray(s.params) ? s.params : [] };
      });
      await db.batch(stmts);
      return { ok: true };
    }
    default: throw TroveError.invalid(`Unknown storage op "${op}"`);
  }
}

function requirePluginStore(sqlite, principal) {
  if (!sqlite) throw TroveError.unsupported('Server plugin storage is not enabled');
  if (!principal) throw TroveError.unauthorized('Authentication required');
}
function requirePlugins(plugins) {
  if (!plugins) throw TroveError.unsupported('Server plugin installs are not enabled');
}

// Turn the core upload plan into a fully self-describing descriptor: how to send
// the bytes (presigned straight to storage, or proxied through us), the limits/quota,
// the auth headers a proxied transfer needs, and every lifecycle endpoint (status,
// (re)sign, report, complete "finished" hook, abort). `{partNumber}` is a template.
function uploadDescriptor(plan) {
  const base = `/api/uploads/${encodeURIComponent(plan.uploadId)}`;
  const transfer = plan.presigned
    ? {
        mode: 'presigned', // client uploads directly to storage; we never see the bytes
        // `single` returns one `url`; multipart `presign` returns `parts[{partNumber,url}]`.
        ...(plan.url ? { url: plan.url } : {}),
        ...(plan.parts ? { parts: plan.parts } : {}),
        requiredHeaders: plan.strategy === 'single' && plan.contentType ? { 'content-type': plan.contentType } : {},
      }
    : {
        mode: 'proxied', // client PUTs each part to us; we stream it to storage
        partUrl: `${base}/parts/{partNumber}`,
        // Proxied PUTs hit our own origin, so they carry the session's ambient auth
        // (cookie/proxy header) automatically — no extra headers needed by default.
        authHeaders: {},
      };
  const endpoints = {
    status: `${base}/status`,
    complete: `${base}/complete`, // the "upload finished" hook — POST reported parts here
    abort: base, // DELETE
    sign: plan.strategy === 'presign' ? `${base}/parts/{partNumber}/sign` : null,
    report: plan.strategy === 'presign' ? `${base}/parts/{partNumber}/report` : null,
  };
  // Drop the now-internal raw transfer fields in favour of `transfer`.
  const { presigned, url, parts, ...rest } = plan;
  return { ...rest, transfer, endpoints };
}

/**
 * A contributor namespace may only be written by whoever owns it.
 *
 * Only a plugin can push through the API, and only under its own contribution URI —
 * which is unforgeable, since it is scoped to the plugin's verified domain and name.
 * That rules out the two things a bare string would allow: writing a built-in's
 * namespace (`core.*`, whose contributions the server produces and nobody else may
 * touch), and writing another plugin's.
 */
async function assertContributorOwned(ctx, contributorId) {
  const parsed = parseContribUri(contributorId);
  if (!parsed || parsed.domain === CORE_DOMAIN) {
    throw TroveError.forbidden(`"${contributorId}" is not a namespace you can contribute to`);
  }
  if (!ctx.plugins) return; // plugin service disabled → no install records to check against
  // The namespace is only unforgeable if we check that the plugin is actually installed.
  // `assertCapability` alone allows when there is no install record (transitional, for
  // device-installed plugins), which made "unforgeable" false in the shipped default:
  // any authenticated caller could contribute under any vendor's name.
  await ctx.plugins.assertInstalled(ctx.principal, parsed.pluginId);
  await ctx.plugins.assertCapability(ctx.principal, parsed.pluginId, 'indexer');
}

/**
 * The collections this caller may read, optionally narrowed to one they asked for.
 * `undefined` when collections are disabled, which means "don't scope" downstream.
 *
 * Every drive-wide query needs this, and it has to be applied INSIDE the query rather
 * than by filtering results: a LIMIT spent on rows the caller can't see would report
 * "no matches" while matches they can see sit just past the cut.
 */
async function readableCollectionIds(ctx, narrowTo) {
  if (!ctx.collections) return undefined;
  const readable = (await ctx.collections.list(ctx.principal)).map((c) => c.id);
  return narrowTo ? readable.filter((id) => id === narrowTo) : readable;
}

async function assertCap(ctx, collectionId, capability) {
  if (!ctx.collections) return; // collections disabled → no per-collection ACL
  await ctx.collections.assert(ctx.principal, collectionId, capability);
}

/**
 * Gate an operation that acts on the whole drive rather than on anything the caller
 * owns — rebuilding the index, cancelling someone else's task. See
 * CollectionService.hasWholeDrive for why this isn't plain `isAdmin`.
 */
async function requireWholeDrive(ctx, what) {
  const allowed = ctx.collections ? await ctx.collections.hasWholeDrive(ctx.principal) : !!ctx.principal;
  if (!allowed) throw TroveError.forbidden(`You do not have permission to ${what}`);
}
const canWholeDrive = (ctx) =>
  (ctx.collections ? ctx.collections.hasWholeDrive(ctx.principal) : Promise.resolve(!!ctx.principal));

/**
 * Who may act on an issue: whoever may act on the thing it is about.
 *
 * An issue names a file ("welcome.md could not be indexed"), so it leaks that file's
 * existence and name — it has to be scoped exactly like the file is. A drive-wide issue
 * belongs to no collection, so it takes admin. This is the same reasoning as
 * readableCollectionIds, applied to a different surface, and it must not be skipped
 * just because an issue "is only an error message".
 */
async function assertIssueAccess(ctx, issue, capability) {
  if (issue.collectionId == null) return requireWholeDrive(ctx, 'act on a drive-wide problem');
  await assertCap(ctx, issue.collectionId, capability);
}

/** Same rule for tasks: a task about a collection follows that collection. */
async function assertTaskAccess(ctx, task, what) {
  if (!task) throw TroveError.notFound('Task');
  if (task.collectionId == null) return requireWholeDrive(ctx, `${what} a drive-wide task`);
  await assertCap(ctx, task.collectionId, 'write');
}
// Stat a node and enforce a capability on its collection in one step — the single
// most repeated shape across the mutating routes.
async function nodeWithCap(ctx, id, capability) {
  const node = await ctx.vfs.stat(id);
  await assertCap(ctx, node.collectionId, capability);
  return node;
}
// Re-check the caller still holds the capability on an in-flight upload's collection.
// The upload lifecycle spans several requests keyed only by an unguessable uploadId;
// without this a revoked grant could still drive/commit the upload.
async function assertUploadCap(ctx, uploadId, capability) {
  const { collectionId } = await ctx.vfs.uploadStatus(uploadId);
  await assertCap(ctx, collectionId, capability);
}
function requirePrincipal(principal) {
  if (!principal) throw TroveError.unauthorized('Authentication required');
}
function requireSidecar(sidecar) {
  if (!sidecar) throw TroveError.unsupported('Conversations are not enabled on this server');
}
function requireNotifications(n) {
  if (!n) throw TroveError.unsupported('Notifications are not enabled on this server');
}
