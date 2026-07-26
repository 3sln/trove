// The Trove HTTP API, mapped onto Vfs methods. JSON in/out except downloads
// (bytes, range-aware) and direct part uploads (raw body). Downloads redirect to
// a presigned URL when the backend supports it, otherwise stream through here.

import { Router, json, parseRange } from './router.js';
import { TroveError, assertSafePluginSql, concatBytes } from '@trove/core';
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
// Read a raw binary body (e.g. an uploaded plugin package), capped like readCapped.
async function readBytesCapped(req, max) {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared && declared > max) throw TroveError.invalid('Request body too large');
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > max) throw TroveError.invalid('Request body too large');
  return buf;
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

// Reject SSRF-prone hosts for the server-side assetlinks fetch: IP literals,
// loopback, link-local (cloud metadata), and internal TLDs. DNS names that resolve
// to private IPs are a residual (rebinding) risk, documented in the README.
function assertPublicHost(hostname) {
  const h = hostname.toLowerCase();
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
  if (h.includes(':')) throw TroveError.invalid('Refusing to fetch from an IP literal');
}

// Which collection a request targets. There is no folder to infer one from any more,
// so it's named explicitly or it's the default.
function collectionOf(src) {
  return src?.collection || src?.collectionId || 'default';
}

export function createRouter() {
  const r = new Router();

  // Liveness: the process is up and serving.
  r.get('/api/health', () => ({ ok: true, service: 'trove', time: Date.now() }));

  // Readiness: the backing store actually answers — for load-balancer / k8s gating.
  r.get('/api/ready', async ({ sqlite }) => {
    try {
      if (sqlite) { const db = await sqlite.obtain({ key: 'metadata' }); await db.get('SELECT 1'); }
      return { ok: true };
    } catch (err) {
      throw TroveError.transient('Storage not ready', { cause: err });
    }
  });

  r.get('/api/capabilities', async (ctx) => {
    const { vfs, config, sidecar, notifications, principal, query } = ctx;
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
        auth: !!principal,
      },
      principal: principal || null,
      search: vfs.search ? vfs.search.describe() : null,
      ...(config?.clientConfig || {}),
    };
  });

  // --- collections -----------------------------------------------------------

  r.get('/api/collections', async ({ collections, principal }) => {
    if (!collections) return { collections: [{ id: 'default', name: 'My Drive', capabilities: ['read', 'write', 'delete', 'admin'] }] };
    return { collections: await collections.list(principal), canCreate: collections.canCreate(principal) };
  });

  r.get('/api/collections/:id', async ({ collections, principal, params }) => {
    if (!collections) return { collection: { id: 'default', name: 'My Drive' } };
    const c = await collections.assert(principal, params.id, 'read');
    return { collection: collections.describe(c, principal) };
  });

  r.post('/api/collections', async ({ collections, principal, req }) => {
    if (!collections) throw TroveError.unsupported('Collections are not enabled');
    const b = await body(req);
    return { collection: await collections.create(b, principal) };
  });

  r.post('/api/collections/:id', async ({ collections, principal, params, req }) => {
    if (!collections) throw TroveError.unsupported('Collections are not enabled');
    const b = await body(req);
    return { collection: await collections.update(params.id, b, principal) };
  });

  r.delete('/api/collections/:id', async ({ collections, principal, params }) => {
    if (!collections) throw TroveError.unsupported('Collections are not enabled');
    return collections.remove(params.id, principal);
  });

  r.post('/api/collections/:id/grants', async ({ collections, principal, params, req }) => {
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
  r.get('/api/items', async (ctx) => {
    const { vfs, query } = ctx;
    const collectionId = collectionOf(query);
    await assertCap(ctx, collectionId, 'read');
    const { items, nextCursor } = await vfs.list(collectionId, {
      sort: query.sort, order: query.order,
      limit: clampLimit(query.limit, 500),
      cursor: query.cursor,
    });
    return { items, nextCursor, collectionId };
  });

  // Resolve an item: by id, by `?name=` within a collection, or by a `trove:` URI.
  r.get('/api/items/resolve', async (ctx) => {
    const { query } = ctx;
    const ref = query.id || query.uri || query.name;
    if (!ref) throw TroveError.invalid('id, name or uri is required');
    const node = await ctx.vfs.stat(ref, collectionOf(query));
    await assertCap(ctx, node.collectionId, 'read');
    return { node };
  });

  // What links to this item — the inverse of the links its own content declares, and
  // what replaces "which folder is it in?".
  r.get('/api/items/backlinks', async (ctx) => {
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

  r.post('/api/items/rename', async (ctx) => {
    const b = await body(ctx.req);
    if (!b.id || !b.newName) throw TroveError.invalid('id and newName are required');
    const node = await ctx.vfs.stat(b.id);
    await assertCap(ctx, node.collectionId, 'write');
    return { node: await ctx.vfs.rename(b.id, b.newName) };
  });

  r.post('/api/items/delete', async (ctx) => {
    const b = await body(ctx.req);
    if (!b.id) throw TroveError.invalid('id is required');
    const node = await ctx.vfs.stat(b.id);
    await assertCap(ctx, node.collectionId, 'delete');
    return ctx.vfs.remove(b.id);
  });

  // --- download (presign redirect or range-aware proxy) ----------------------

  r.get('/api/items/download', async (ctx) => {
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
      'content-disposition': `${attach ? 'attachment' : 'inline'}; filename="${encodeURIComponent(node.name)}"`,
      'cache-control': 'private, max-age=0',
    };
    if (served) {
      headers['content-range'] = `bytes ${served.start}-${served.end}/${served.total}`;
      return new Response(stream, { status: 206, headers });
    }
    return new Response(stream, { status: 200, headers });
  });

  // --- uploads ---------------------------------------------------------------

  r.post('/api/uploads', async (ctx) => {
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

  r.get('/api/uploads/:id/status', async (ctx) => {
    await assertUploadCap(ctx, ctx.params.id, 'write');
    return ctx.vfs.uploadStatus(ctx.params.id);
  });

  r.post('/api/uploads/:id/parts/:n/sign', async (ctx) => {
    await assertUploadCap(ctx, ctx.params.id, 'write');
    return { url: await ctx.vfs.signUploadPart(ctx.params.id, Number(ctx.params.n)) };
  });

  r.post('/api/uploads/:id/parts/:n/report', async (ctx) => {
    await assertUploadCap(ctx, ctx.params.id, 'write');
    const b = await body(ctx.req);
    return ctx.vfs.reportUploadPart(ctx.params.id, Number(ctx.params.n), b.etag);
  });

  // Direct part upload — raw body streamed to storage.
  r.put('/api/uploads/:id/parts/:n', async (ctx) => {
    await assertUploadCap(ctx, ctx.params.id, 'write');
    const res = await ctx.vfs.uploadPart(ctx.params.id, Number(ctx.params.n), ctx.req.body ?? new Uint8Array(0));
    return json(res);
  });

  r.post('/api/uploads/:id/complete', async (ctx) => {
    await assertUploadCap(ctx, ctx.params.id, 'write');
    const b = await body(ctx.req);
    return { node: await ctx.vfs.completeUpload(ctx.params.id, b.parts) };
  });

  r.delete('/api/uploads/:id', async (ctx) => {
    await assertUploadCap(ctx, ctx.params.id, 'write');
    await ctx.vfs.abortUpload(ctx.params.id);
    return { ok: true };
  });

  // --- search & indexing -----------------------------------------------------

  r.get('/api/search', async (ctx) => {
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
  r.post('/api/query', async (ctx) => {
    const b = await body(ctx.req);
    if (typeof b.q !== 'string' || !b.q.trim()) throw TroveError.invalid('q is required');
    const collectionIds = await readableCollectionIds(ctx, b.collection);
    const { results, resolved } = await ctx.vfs.query(b.q, {
      mode: b.mode, limit: clampLimit(b.limit, 40), collectionIds,
    });
    return { query: b.q, results, resolved };
  });

  // Drive-wide tag/property filter (the launcher's `#tag` / `#key:op:value`).
  r.post('/api/tags/search', async (ctx) => {
    const b = await body(ctx.req);
    const filters = Array.isArray(b.filters) ? b.filters : [];
    const collectionIds = await readableCollectionIds(ctx, b.collection);
    const items = await ctx.vfs.findByTags(filters, {
      q: b.q, collectionIds, limit: clampLimit(b.limit, 100),
    });
    return { items };
  });

  r.get('/api/indexers', ({ vfs }) => ({ indexers: vfs.indexers.list() }));

  // Plugin indexers push a namespaced contribution here (semanticTexts / tags /
  // metadata; legacy documents/facet accepted). The namespace is the path param,
  // so a plugin can only ever write under its own id.
  // Push a contribution under a contributor namespace. TWO gates, because they answer
  // different questions: `write` on the collection says you may change this item at
  // all, and namespace ownership says you may speak AS this contributor. Without the
  // second, anyone who can write anywhere could overwrite `core.links` and quietly
  // break every backlink, or impersonate another plugin's index.
  r.post('/api/index/:indexerId', async (ctx) => {
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

  r.get('/api/tasks', async (ctx) => {
    const collectionIds = await readableCollectionIds(ctx);
    return {
      tasks: ctx.tasks.list({
        collectionIds,
        // A drive-wide task (a full reindex) names no collection, so scoping can't
        // place it — only someone who can act on the whole drive is shown one.
        includeGlobal: await canWholeDrive(ctx),
      }),
    };
  });

  r.post('/api/tasks/:id/cancel', async (ctx) => {
    await assertTaskAccess(ctx, ctx.tasks.get(ctx.params.id), 'cancel');
    return { cancelled: ctx.tasks.cancel(ctx.params.id) };
  });

  r.delete('/api/tasks/:id', async (ctx) => {
    await assertTaskAccess(ctx, ctx.tasks.get(ctx.params.id), 'dismiss');
    ctx.tasks.dismiss(ctx.params.id);
    return { ok: true };
  });

  r.get('/api/issues', async (ctx) => {
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
  r.post('/api/issues/:id/retry', async (ctx) => {
    const issue = await ctx.issues.get(ctx.params.id);
    if (!issue) throw TroveError.notFound('Issue');
    await assertIssueAccess(ctx, issue, 'write');
    const started = ctx.issues.retry(ctx.params.id);
    started.catch(() => {}); // the task record carries the failure; don't reject globally
    // Hand back the task list so the client can adopt the new task without a round trip.
    return { ok: true, tasks: ctx.tasks.list({ collectionIds: await readableCollectionIds(ctx) }) };
  });

  // Dismissing is not fixing. Allowed because a problem can become irrelevant (the file
  // was deleted, the plugin uninstalled) and a list you can't clear stops being read —
  // but if the underlying failure recurs, it comes straight back.
  r.delete('/api/issues/:id', async (ctx) => {
    const issue = await ctx.issues.get(ctx.params.id);
    if (!issue) return { ok: true };
    await assertIssueAccess(ctx, issue, 'write');
    await ctx.issues.remove(ctx.params.id);
    return { ok: true };
  });

  // Rebuild the search index on demand. Admin-only: it re-reads every object in the
  // drive, so it is a real load, and it is drive-wide rather than scoped to anything
  // the caller owns. Returns the task, which is how the caller watches it.
  r.post('/api/reindex', async (ctx) => {
    await requireWholeDrive(ctx, 'rebuild the search index');
    if (!ctx.startReindex) throw TroveError.unsupported('Reindexing is not available on this deployment');
    const running = ctx.tasks.list().find((t) => t.kind === 'index' && t.status === 'running');
    // Two concurrent full rebuilds would double the work to reach the same place.
    if (running) return { task: running, alreadyRunning: true };
    const task = ctx.startReindex({ reason: 'Started manually' });
    task.catch(() => {});
    return { task: ctx.tasks.list().find((t) => t.kind === 'index' && t.status === 'running') || null };
  });

  // --- identity --------------------------------------------------------------

  r.get('/api/me', ({ principal, collections }) => ({
    principal: principal || null,
    authenticated: !!principal,
    admin: collections ? collections.isAdmin(principal) : !!principal,
  }));

  // --- conversations, tags, sidecar (per file) -------------------------------
  // The :id is a file node id; the sidecar is that file's CRDT document.

  r.get('/api/items/:id/sidecar', async (ctx) => {
    requireSidecar(ctx.sidecar);
    await nodeWithCap(ctx, ctx.params.id, 'read'); // 404 if the file is gone
    return ctx.sidecar.view(ctx.params.id);
  });

  r.post('/api/items/:id/comments', async (ctx) => {
    requireSidecar(ctx.sidecar);
    requirePrincipal(ctx.principal);
    await nodeWithCap(ctx, ctx.params.id, 'write');
    const b = await body(ctx.req);
    return { comment: await ctx.sidecar.addComment(ctx.params.id, { body: b.body, parentId: b.parentId, mentions: b.mentions }, ctx.principal) };
  });

  r.post('/api/items/:id/comments/:cid/edit', async (ctx) => {
    requireSidecar(ctx.sidecar);
    requirePrincipal(ctx.principal);
    await nodeWithCap(ctx, ctx.params.id, 'write'); // + authorship checked in the service
    const b = await body(ctx.req);
    return { comment: await ctx.sidecar.editComment(ctx.params.id, ctx.params.cid, b.body, ctx.principal) };
  });

  r.delete('/api/items/:id/comments/:cid', async (ctx) => {
    requireSidecar(ctx.sidecar);
    requirePrincipal(ctx.principal);
    await nodeWithCap(ctx, ctx.params.id, 'write'); // + authorship checked in the service
    return ctx.sidecar.deleteComment(ctx.params.id, ctx.params.cid, ctx.principal);
  });

  r.post('/api/items/:id/comments/:cid/react', async (ctx) => {
    requireSidecar(ctx.sidecar);
    requirePrincipal(ctx.principal);
    await nodeWithCap(ctx, ctx.params.id, 'write');
    const b = await body(ctx.req);
    if (!b.emoji) throw TroveError.invalid('emoji is required');
    return { comment: await ctx.sidecar.react(ctx.params.id, ctx.params.cid, b.emoji, b.on !== false, ctx.principal) };
  });

  r.post('/api/items/:id/tags', async (ctx) => {
    requireSidecar(ctx.sidecar);
    await nodeWithCap(ctx, ctx.params.id, 'write');
    const b = await body(ctx.req);
    if (!b.name) throw TroveError.invalid('name is required');
    // The façade sets the CRDT tag AND its queryable mirror together (no swallow).
    return ctx.vfs.setTag(ctx.params.id, b.name, b.value, ctx.principal);
  });

  r.delete('/api/items/:id/tags/:name', async (ctx) => {
    requireSidecar(ctx.sidecar);
    // Removing a tag is a write — enforce the same per-collection ACL as adding one,
    // or a read-only user could strip tags off files they can't modify.
    await nodeWithCap(ctx, ctx.params.id, 'write');
    return ctx.vfs.removeTag(ctx.params.id, ctx.params.name, ctx.principal);
  });

  r.post('/api/items/:id/subscribe', async (ctx) => {
    requireSidecar(ctx.sidecar);
    requirePrincipal(ctx.principal);
    await nodeWithCap(ctx, ctx.params.id, 'read');
    const b = await body(ctx.req);
    return ctx.sidecar.subscribe(ctx.params.id, ctx.principal, !!b.muted);
  });
  r.delete('/api/items/:id/subscribe', async (ctx) => {
    requireSidecar(ctx.sidecar);
    requirePrincipal(ctx.principal);
    await nodeWithCap(ctx, ctx.params.id, 'read');
    return ctx.sidecar.unsubscribe(ctx.params.id, ctx.principal);
  });

  // --- notifications & web push ----------------------------------------------

  r.get('/api/notifications', async ({ notifications, principal }) => {
    requireNotifications(notifications);
    requirePrincipal(principal);
    return notifications.inbox(principal.id);
  });
  r.post('/api/notifications/read', async ({ notifications, principal, req }) => {
    requireNotifications(notifications);
    requirePrincipal(principal);
    const b = await body(req);
    return notifications.markRead(principal.id, b.ids);
  });

  r.get('/api/push/vapid', ({ notifications }) => ({ publicKey: notifications?.vapidPublicKey() || null }));

  r.post('/api/push/subscribe', async ({ notifications, principal, req }) => {
    requireNotifications(notifications);
    requirePrincipal(principal);
    const b = await body(req);
    return notifications.subscribePush(principal.id, b.subscription);
  });
  r.delete('/api/push/subscribe', async ({ notifications, principal, req }) => {
    requireNotifications(notifications);
    requirePrincipal(principal);
    const b = await body(req);
    return notifications.unsubscribePush(principal.id, b.endpoint);
  });

  // --- plugins: domain verification proxy + per-plugin server storage --------

  // Fetch a plugin domain's assetlinks doc server-side (avoids browser CORS).
  r.get('/api/plugins/assetlinks', async ({ query, principal }) => {
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
  r.post('/api/plugins/install', async ({ plugins, principal, req, query }) => {
    requirePlugins(plugins);
    requirePrincipal(principal);
    const bytes = await readBytesCapped(req, plugins.maxPackageBytes || 32 * 1024 * 1024);
    const grants = query.grants ? String(query.grants).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    return { install: await plugins.install({ principal, bytes, grants }) };
  });

  // List this account's server-installed plugins (for cross-device sync).
  r.get('/api/plugins/installed', async ({ plugins, principal }) => {
    requirePlugins(plugins);
    requirePrincipal(principal);
    return { plugins: await plugins.list(principal) };
  });

  // Download a plugin's package blob so another device can enable it locally.
  r.get('/api/plugins/:pluginId/package', async ({ plugins, principal, params }) => {
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
  r.delete('/api/plugins/:pluginId/install', async ({ plugins, sqlite, principal, params }) => {
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

  r.post('/api/plugins/:pluginId/sql', async ({ sqlite, plugins, principal, params, req }) => {
    requirePluginStore(sqlite, principal);
    // Authoritative capability check when the plugin is server-installed (transitional:
    // allowed if there's no install record — device plugins predate this).
    if (plugins) await plugins.assertCapability(principal, params.pluginId, 'storage');
    const { scope = 'plugin', op, sql, params: args = [], statements, domain } = await body(req);
    if (!PLUGIN_SQL_OPS.has(op)) throw TroveError.invalid(`Unknown storage op "${op}"`);
    if (scope !== 'plugin' && scope !== 'domain') throw TroveError.invalid(`Unknown storage scope "${scope}"`);
    if (scope === 'domain' && !domain) throw TroveError.invalid('domain scope requires a domain');
    const db = await sqlite.obtain({ key: storeKey(principal, params.pluginId, scope, domain) });
    return { result: await runPluginSql(db, op, { sql, args, statements }) };
  });

  // Uninstall cleanup: wipe the plugin-private scope. The domain scope is shared
  // across a vendor's plugins and deliberately outlives any single uninstall.
  r.delete('/api/plugins/:pluginId/data', async ({ sqlite, principal, params }) => {
    requirePluginStore(sqlite, principal);
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
