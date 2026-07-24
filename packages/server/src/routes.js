// The Trove HTTP API, mapped onto Vfs methods. JSON in/out except downloads
// (bytes, range-aware) and direct part uploads (raw body). Downloads redirect to
// a presigned URL when the backend supports it, otherwise stream through here.

import { Router, json, parseRange } from './router.js';
import { TroveError, assertSafePluginSql } from '@trove/core';

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
  return new TextDecoder().decode(concatBytes(chunks, total));
}
function concatBytes(chunks, total) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
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

// Accept either ?path=/x or ?id=... ; body may carry parentId or parentPath.
async function resolveParent(vfs, src) {
  if (src.parentId) return src.parentId;
  if (src.parentPath) return (await vfs.stat(src.parentPath)).id;
  return 'root';
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
      throw new TroveError('transient', 'Storage not ready', { cause: err });
    }
  });

  r.get('/api/capabilities', ({ vfs, config, sidecar, notifications, principal }) => ({
    storage: vfs.storage.capabilities,
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
    search: vfs.search
      ? {
          vectorStore: vfs.search.vectors?.constructor?.name || null,
          keywordStore: vfs.search.keywords?.constructor?.name || null,
          embeddings: vfs.search.embeddings?.constructor?.name || null,
          dimensions: vfs.search.vectors?.dimensions || null,
        }
      : null,
    ...(config?.clientConfig || {}),
  }));

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

  r.get('/api/fs/list', async (ctx) => {
    const { vfs, query } = ctx;
    const pathOrId = query.id || query.path || '/';
    const node = await vfs.stat(pathOrId, query.collection);
    await assertCap(ctx, node.collectionId, 'read');
    const { items, nextCursor } = await vfs.list(node.id, {
      sort: query.sort, order: query.order,
      limit: clampLimit(query.limit, 500),
      cursor: query.cursor,
    });
    const breadcrumb = await vfs.breadcrumb(node.id);
    return { node, items, nextCursor, breadcrumb, collectionId: node.collectionId };
  });

  r.get('/api/fs/stat', async (ctx) => {
    const node = await ctx.vfs.stat(ctx.query.id || ctx.query.path, ctx.query.collection);
    await assertCap(ctx, node.collectionId, 'read');
    return { node, breadcrumb: await ctx.vfs.breadcrumb(node.id) };
  });

  r.post('/api/fs/folder', async (ctx) => {
    const b = await body(ctx.req);
    if (!b.name) throw TroveError.invalid('name is required');
    const parent = await ctx.vfs.stat(await resolveParent(ctx.vfs, b), b.collection);
    await assertCap(ctx, parent.collectionId, 'write');
    return { node: await ctx.vfs.mkdir(parent.id, b.name) };
  });

  r.post('/api/fs/move', async (ctx) => {
    const b = await body(ctx.req);
    if (!b.id) throw TroveError.invalid('id is required');
    const node = await ctx.vfs.stat(b.id);
    await assertCap(ctx, node.collectionId, 'write');
    const destParentId = b.destParentId || (b.destParentPath ? (await ctx.vfs.stat(b.destParentPath, b.collection)).id : undefined);
    if (!destParentId) throw TroveError.invalid('destParentId is required');
    return { node: await ctx.vfs.move(b.id, destParentId, b.newName) };
  });

  r.post('/api/fs/rename', async (ctx) => {
    const b = await body(ctx.req);
    if (!b.id || !b.newName) throw TroveError.invalid('id and newName are required');
    const node = await ctx.vfs.stat(b.id);
    await assertCap(ctx, node.collectionId, 'write');
    return { node: await ctx.vfs.rename(b.id, b.newName) };
  });

  r.post('/api/fs/delete', async (ctx) => {
    const b = await body(ctx.req);
    if (!b.id) throw TroveError.invalid('id is required');
    const node = await ctx.vfs.stat(b.id);
    await assertCap(ctx, node.collectionId, 'delete');
    return ctx.vfs.remove(b.id, { recursive: b.recursive !== false });
  });

  // --- download (presign redirect or range-aware proxy) ----------------------

  r.get('/api/fs/download', async (ctx) => {
    const { vfs, query, req } = ctx;
    const id = query.id;
    if (!id) throw TroveError.invalid('id is required');
    await assertCap(ctx, (await vfs.stat(id)).collectionId, 'read');
    const node = await vfs.stat(id);
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
    const parent = await ctx.vfs.stat(await resolveParent(ctx.vfs, b), b.collection);
    await assertCap(ctx, parent.collectionId, 'write');
    const plan = await ctx.vfs.createUpload({
      parentId: parent.id, name: b.name, size: Number(b.size ?? 0), contentType: b.contentType,
    });
    return uploadDescriptor(plan);
  });

  r.get('/api/uploads/:id/status', ({ vfs, params }) => vfs.uploadStatus(params.id));

  r.post('/api/uploads/:id/parts/:n/sign', async ({ vfs, params }) => ({
    url: await vfs.signUploadPart(params.id, Number(params.n)),
  }));

  r.post('/api/uploads/:id/parts/:n/report', async ({ vfs, params, req }) => {
    const b = await body(req);
    return vfs.reportUploadPart(params.id, Number(params.n), b.etag);
  });

  // Direct part upload — raw body streamed to storage.
  r.put('/api/uploads/:id/parts/:n', async ({ vfs, params, req }) => {
    const res = await vfs.uploadPart(params.id, Number(params.n), req.body ?? new Uint8Array(0));
    return json(res);
  });

  r.post('/api/uploads/:id/complete', async ({ vfs, params, req }) => {
    const b = await body(req);
    return { node: await vfs.completeUpload(params.id, b.parts) };
  });

  r.delete('/api/uploads/:id', async ({ vfs, params }) => {
    await vfs.abortUpload(params.id);
    return { ok: true };
  });

  // --- search & indexing -----------------------------------------------------

  r.get('/api/search', async ({ vfs, query, collections, principal }) => {
    if (!query.q) throw TroveError.invalid('q is required');
    // Only search collections the caller can read.
    let collectionIds;
    if (collections) {
      const readable = (await collections.list(principal)).map((c) => c.id);
      collectionIds = query.collection ? readable.filter((id) => id === query.collection) : readable;
    }
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
  r.post('/api/query', async ({ vfs, collections, principal, req }) => {
    const b = await body(req);
    if (typeof b.q !== 'string' || !b.q.trim()) throw TroveError.invalid('q is required');
    let collectionIds;
    if (collections) {
      const readable = (await collections.list(principal)).map((c) => c.id);
      collectionIds = b.collection ? readable.filter((id) => id === b.collection) : readable;
    }
    const { results, resolved } = await vfs.query(b.q, {
      mode: b.mode, limit: clampLimit(b.limit, 40), collectionIds,
    });
    return { query: b.q, results, resolved };
  });

  // Drive-wide tag/property filter (the launcher's `#tag` / `#key:op:value`).
  r.post('/api/tags/search', async ({ vfs, collections, principal, req }) => {
    const b = await body(req);
    const filters = Array.isArray(b.filters) ? b.filters : [];
    let collectionIds;
    if (collections) {
      const readable = (await collections.list(principal)).map((c) => c.id);
      collectionIds = b.collection ? readable.filter((id) => id === b.collection) : readable;
    }
    const items = await vfs.metadata.findByTags(filters, {
      q: b.q, collectionIds, limit: clampLimit(b.limit, 100),
    });
    return { items };
  });

  r.get('/api/indexers', ({ vfs }) => ({ indexers: vfs.indexers.list() }));

  // Plugin indexers push a namespaced contribution here (semanticTexts / tags /
  // metadata; legacy documents/facet accepted). The namespace is the path param,
  // so a plugin can only ever write under its own id.
  r.post('/api/index/:indexerId', async (ctx) => {
    const b = await body(ctx.req);
    if (!b.nodeId) throw TroveError.invalid('nodeId is required');
    await assertCap(ctx, (await ctx.vfs.stat(b.nodeId)).collectionId, 'write');
    return ctx.vfs.indexContributions(b.nodeId, ctx.params.indexerId, {
      semanticTexts: b.semanticTexts, tags: b.tags, metadata: b.metadata,
      documents: b.documents, facet: b.facet, // legacy
    });
  });

  // --- identity --------------------------------------------------------------

  r.get('/api/me', ({ principal, collections }) => ({
    principal: principal || null,
    authenticated: !!principal,
    admin: collections ? collections.isAdmin(principal) : !!principal,
  }));

  // --- conversations, tags, sidecar (per file) -------------------------------
  // The :id is a file node id; the sidecar is that file's CRDT document.

  r.get('/api/files/:id/sidecar', async (ctx) => {
    requireSidecar(ctx.sidecar);
    const node = await ctx.vfs.stat(ctx.params.id); // 404 if the file is gone
    await assertCap(ctx, node.collectionId, 'read');
    return ctx.sidecar.view(ctx.params.id);
  });

  r.post('/api/files/:id/comments', async (ctx) => {
    requireSidecar(ctx.sidecar);
    requirePrincipal(ctx.principal);
    const node = await ctx.vfs.stat(ctx.params.id);
    await assertCap(ctx, node.collectionId, 'write');
    const b = await body(ctx.req);
    return { comment: await ctx.sidecar.addComment(ctx.params.id, { body: b.body, parentId: b.parentId, mentions: b.mentions }, ctx.principal) };
  });

  r.post('/api/files/:id/comments/:cid/edit', async (ctx) => {
    requireSidecar(ctx.sidecar);
    requirePrincipal(ctx.principal);
    const node = await ctx.vfs.stat(ctx.params.id);
    await assertCap(ctx, node.collectionId, 'write'); // + authorship checked in the service
    const b = await body(ctx.req);
    return { comment: await ctx.sidecar.editComment(ctx.params.id, ctx.params.cid, b.body, ctx.principal) };
  });

  r.delete('/api/files/:id/comments/:cid', async (ctx) => {
    requireSidecar(ctx.sidecar);
    requirePrincipal(ctx.principal);
    const node = await ctx.vfs.stat(ctx.params.id);
    await assertCap(ctx, node.collectionId, 'write'); // + authorship checked in the service
    return ctx.sidecar.deleteComment(ctx.params.id, ctx.params.cid, ctx.principal);
  });

  r.post('/api/files/:id/comments/:cid/react', async (ctx) => {
    requireSidecar(ctx.sidecar);
    requirePrincipal(ctx.principal);
    const node = await ctx.vfs.stat(ctx.params.id);
    await assertCap(ctx, node.collectionId, 'write');
    const b = await body(ctx.req);
    if (!b.emoji) throw TroveError.invalid('emoji is required');
    return { comment: await ctx.sidecar.react(ctx.params.id, ctx.params.cid, b.emoji, b.on !== false, ctx.principal) };
  });

  r.post('/api/files/:id/tags', async (ctx) => {
    requireSidecar(ctx.sidecar);
    const node = await ctx.vfs.stat(ctx.params.id);
    await assertCap(ctx, node.collectionId, 'write');
    const b = await body(ctx.req);
    if (!b.name) throw TroveError.invalid('name is required');
    const res = await ctx.sidecar.setTag(ctx.params.id, b.name, b.value, ctx.principal);
    // Mirror the tag into the queryable 'user' contribution scope so it's filterable
    // (#tag / #tag:=value) alongside indexer-contributed tags.
    await ctx.vfs.metadata.setContribution(ctx.params.id, 'user', { tags: { [b.name]: b.value ?? true } }).catch(() => {});
    return res;
  });

  r.delete('/api/files/:id/tags/:name', async ({ sidecar, vfs, params, principal }) => {
    requireSidecar(sidecar);
    const res = await sidecar.removeTag(params.id, params.name, principal);
    // Null clears the merged tag (the matcher reads null as "absent").
    await vfs.metadata.setContribution(params.id, 'user', { tags: { [params.name]: null } }).catch(() => {});
    return res;
  });

  r.post('/api/files/:id/subscribe', async (ctx) => {
    requireSidecar(ctx.sidecar);
    requirePrincipal(ctx.principal);
    const node = await ctx.vfs.stat(ctx.params.id);
    await assertCap(ctx, node.collectionId, 'read');
    const b = await body(ctx.req);
    return ctx.sidecar.subscribe(ctx.params.id, ctx.principal, !!b.muted);
  });
  r.delete('/api/files/:id/subscribe', async (ctx) => {
    requireSidecar(ctx.sidecar);
    requirePrincipal(ctx.principal);
    const node = await ctx.vfs.stat(ctx.params.id);
    await assertCap(ctx, node.collectionId, 'read');
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

  r.post('/api/plugins/:pluginId/sql', async ({ sqlite, principal, params, req }) => {
    requirePluginStore(sqlite, principal);
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

async function assertCap(ctx, collectionId, capability) {
  if (!ctx.collections) return; // collections disabled → no per-collection ACL
  await ctx.collections.assert(ctx.principal, collectionId, capability);
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
