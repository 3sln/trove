// The Trove HTTP API, mapped onto Vfs methods. JSON in/out except downloads
// (bytes, range-aware) and direct part uploads (raw body). Downloads redirect to
// a presigned URL when the backend supports it, otherwise stream through here.

import { Router, json, parseRange } from './router.js';
import {
  TroveError, assertSafePluginSql, concatBytes, metadataUrl, publicOrigin,
  shouldEncrypt, estimateRotationCost, toHex,
} from '@3sln/trove/core';
import { parseContribUri, CORE_DOMAIN } from '@3sln/trove/core/plugins/identity.js';

const ENV = typeof process !== 'undefined' ? (process.env || {}) : {};
// Cap JSON request bodies so a giant payload can't exhaust server memory. Uploads
// don't use body() (their bytes stream straight to storage), so this is safe to keep small.
const MAX_JSON_BYTES = Number(ENV.TROVE_MAX_JSON_BYTES || 4 * 1024 * 1024);
// Clamp any client-supplied result limit to a sane ceiling (DoS via huge scans).
const MAX_PAGE = Number(ENV.TROVE_MAX_PAGE || 1000);
// How many signed URLs one request may mint. A gallery asks for what it is about to
// draw, not for the whole drive — and each one costs an authorization check.
const URL_MINT_BATCH = Number(ENV.TROVE_URL_BATCH || 200);

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
/**
 * The collection a request is scoped to, from the PATH.
 *
 * There is no fallback. A collection-scoped route names its collection in the URL —
 * `/api/collections/:collection/items` — so a request that does not name one cannot
 * reach the handler at all, and the router refuses it before this is called.
 *
 * The fallback that used to live here (`?collection=` or else `'default'`) was the same
 * class of bug as everything else in this file's history: a missing value silently
 * became a specific one, so an unscoped write went somewhere real and looked fine. On a
 * multi-user drive that somewhere was a collection plenty of people cannot even read.
 */
function scopedCollection(ctx) {
  const id = ctx.params?.collection;
  if (!id) throw TroveError.invalid('This endpoint is scoped to a collection');
  return id;
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
      storage = await (await ctx.access.collection(query.collection, 'read')).storage();
    }
    return {
      collection: query.collection || null,
      storage: storage.capabilities,
      // What kinds of backing store THIS deployment can build, with the fields each one
      // needs. The collection form used to hardcode this list, which is how a Cloudflare
      // Workers drive came to offer "Filesystem / NAS" — a choice its runtime cannot
      // honour. Answered by the server now, so the form can only offer what exists.
      storageDrivers: ctx.config.storageRegistry?.describe?.() || [],
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

  r.get('/api/collections', ['collections'], async (ctx) => {
    const { collections, principal } = ctx;
    return { collections: await collections.list(principal), canCreate: collections.canCreate(principal) };
  });

  r.get('/api/collections/:id', ['collections'], async (ctx) => {
    const { collections, principal, params } = ctx;
    const c = await collections.assert(principal, params.id, 'read');
    return { collection: collections.describe(c, principal) };
  });

  r.post('/api/collections', ['collections'], async (ctx) => {
    requireCollections(ctx);
    return { collection: await ctx.collections.create(await body(ctx.req), ctx.principal) };
  });

  r.post('/api/collections/:id', ['collections'], async (ctx) => {
    requireCollections(ctx);
    return { collection: await ctx.collections.update(ctx.params.id, await body(ctx.req), ctx.principal) };
  });

  r.delete('/api/collections/:id', ['collections', 'vfs'], async (ctx) => {
    requireCollections(ctx);
    const { collections, vfs, principal, params } = ctx;
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

  r.post('/api/collections/:id/grants', ['collections'], async (ctx) => {
    requireCollections(ctx);
    return { collection: await ctx.collections.setGrant(ctx.params.id, await body(ctx.req), ctx.principal) };
  });

  // --- API keys ---------------------------------------------------------------
  //
  // Managing keys requires a real admin PRINCIPAL, and a key can never be used to reach
  // these routes — `requireHumanAdmin` refuses when the request arrived on a grant. That
  // asymmetry is deliberate: a key that could mint keys is a key that can escalate
  // itself, and revoking it would not revoke what it had already issued. The blast
  // radius of a leaked key stops at the capabilities it was given.

  r.get('/api/keys', ['apiKeys', 'collections'], async (ctx) => {
    requireHumanAdmin(ctx, 'manage API keys');
    return { keys: await ctx.apiKeys.list() };
  });

  r.post('/api/keys', ['apiKeys', 'collections'], async (ctx) => {
    requireHumanAdmin(ctx, 'mint API keys');
    const b = await body(ctx.req);
    // The secret comes back exactly once, here, and is never retrievable again.
    const { record, secret } = await ctx.apiKeys.mint({
      name: b.name,
      scopes: b.scopes,
      expiresAt: b.expiresAt ?? null,
      createdBy: ctx.principal?.id ?? null,
    });
    return { key: record, secret };
  });

  r.delete('/api/keys/:id', ['apiKeys', 'collections'], async (ctx) => {
    requireHumanAdmin(ctx, 'revoke API keys');
    return { key: await ctx.apiKeys.revoke(ctx.params.id) };
  });

  // --- browse ----------------------------------------------------------------

  // --- items -----------------------------------------------------------------
  // One noun: there is no filesystem and no folders, so everything addressable is an
  // item in a collection. Collection-level verbs sit at `/api/items/<verb>` and
  // item-scoped ones at `/api/items/:id/…`. The router matches in registration order,
  // so these literal routes must stay ABOVE any same-length `:id` route added later.

  // Every item in a collection. There is nothing to descend into — a drive is browsed
  // by search and by following links, and this is the "show me everything" fallback.
  r.get('/api/collections/:collection/items', ['vfs'], async (ctx) => {
    const { vfs, query } = ctx;
    const collectionId = scopedCollection(ctx);
    const collection = await ctx.access.collection(collectionId, 'read');
    const { items, nextCursor } = await collection.list({
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
    const usage = await collection.usage().catch(() => null);
    return { items, nextCursor, collectionId, stats, usage };
  });

  // Resolve an item: by id, by `?name=` within a collection, or by a `trove:` URI.
  r.get('/api/collections/:collection/items/resolve', [], async (ctx) => {
    const ref = ctx.query.id || ctx.query.uri || ctx.query.name;
    if (!ref) throw TroveError.invalid('id, name or uri is required');
    // A name is only unique within a collection, which is the reason this one is scoped
    // by path at all: resolving `notes.md` is a different question in each collection.
    const handle = await ctx.access.node(ref, 'read', { collectionId: scopedCollection(ctx) });
    return { node: handle.node };
  });

  // What links to this item — the inverse of the links its own content declares, and
  // what replaces "which folder is it in?".
  r.get('/api/items/backlinks', ['collections'], async (ctx) => {
    const node = await ctx.access.node(ctx.query.id, 'read');
    // Scoped in the query, not filtered after: backlinks cross collections, so a limit
    // spent on unreadable rows would report "nothing links here" while something the
    // caller can see sits just past the cut.
    const items = await node.backlinks({
      limit: clampLimit(ctx.query.limit, 100),
      collectionIds: await readableCollectionIds(ctx),
    });
    return { items };
  });

  r.post('/api/items/rename', [], async (ctx) => {
    const b = await body(ctx.req);
    if (!b.id || !b.newName) throw TroveError.invalid('id and newName are required');
    const node = await ctx.access.node(b.id, 'write');
    return { node: await node.rename(b.newName) };
  });

  r.post('/api/items/delete', [], async (ctx) => {
    const b = await body(ctx.req);
    if (!b.id) throw TroveError.invalid('id is required');
    return (await ctx.access.node(b.id, 'delete')).remove();
  });

  // How long a download plan's URL is good for. Twelve hours, matching the `media`
  // signed-URL purpose and for the same reason stated there.
  const PLAN_TTL_SECONDS = 12 * 60 * 60;

  // --- download (presign redirect or range-aware proxy) ----------------------

  /**
   * How to fetch this object's bytes WITHOUT going through the drive.
   *
   * The mirror of the upload plan, and the same trade: the key travels, the bytes do not.
   * Encryption here defends the storage host, not the server and not the client — the
   * server holds the key already in order to index — so handing the key to a caller that
   * may already read the file costs nothing and buys a download that never touches us.
   * Without this, encryption silently disabled direct downloads: `getDownload` refuses to
   * redirect to ciphertext unless asked, nothing asked, and so every read of an encrypted
   * collection proxied — the collections that most wanted direct transfer got the least.
   *
   * Session auth only, which is simply what a JSON endpoint gets by not asking for more.
   * Signed URLs are for callers that cannot send a header and want BYTES — an <img src>, a
   * <video src>, cache.add(); a plan is read by code, and code has a session. Worth one
   * line only as a note to whoever might later extend signatures across the API: leave
   * this endpoint out, because a signature grants `read` on one node and the key this
   * returns opens the whole collection.
   *
   * `fingerprint` selects which key, because mid-rotation the object's own header is the
   * authority on what sealed it and some objects are still on the retired key. The caller
   * reads the header, then asks for the key that matches it.
   */
  r.get('/api/items/download/plan', ['collections'], async (ctx) => {
    const { query } = ctx;
    if (!query.id) throw TroveError.invalid('id is required');
    const node = await ctx.access.node(query.id, 'read');
    // Long-lived on purpose, and `expiresAt` travels with it so a caller can hold the plan
    // rather than re-ask per request. Same reasoning as the `media` signed-URL purpose: a
    // <video> re-requests on every seek, so this has to outlive the SITTING, not the
    // request — an evening of episodes, not one GET.
    const expiresIn = PLAN_TTL_SECONDS;
    const d = await node.download({ ciphertext: true, expiresIn });
    // Not presign-capable, or nothing to redirect to: say so plainly rather than inventing
    // a URL, and the caller keeps proxying.
    if (d.mode !== 'redirect') return { direct: false };
    const expiresAt = Date.now() + expiresIn * 1000;
    const enc = d.encryption || null;
    // The content type travels with the plan: the caller is building the Response the
    // browser will see, and a decrypted <img>/<video> body served as octet-stream does not
    // render.
    const contentType = node.contentType || 'application/octet-stream';
    if (!enc) return { direct: true, url: d.url, contentType, expiresAt, encryption: null };
    const key = ctx.collections?.dataKeyFor
      ? await ctx.collections.dataKeyFor(node.collectionId, query.fingerprint || undefined)
      : null;
    // A collection whose key this server cannot produce is one the caller cannot decrypt,
    // so offering the direct URL would hand over bytes it can only fail on.
    if (!key) return { direct: false };
    return {
      direct: true,
      url: d.url,
      contentType,
      expiresAt,
      encryption: {
        algorithm: 'AES-256-GCM',
        chunkSize: enc.chunkSize,
        fingerprint: enc.fingerprint,
        key: toHex(key),
      },
    };
  });

  r.get('/api/items/download', [], async (ctx) => {
    const { query, req } = ctx;
    if (!query.id) throw TroveError.invalid('id is required');
    // A signed URL brings its own grant, because the things that need one — an <img
    // src>, a <video src>, cache.add(), an external service an indexer handed a URL to
    // — cannot send an Authorization header at all. It grants `read` on exactly the node
    // it names; see engine/providers/access.js and docs/design/signed-urls.md.
    const signature = query.sig ? { op: query.op, exp: query.exp, sig: query.sig } : null;
    const node = await ctx.access.node(query.id, 'read', { signature });
    const ct = node.contentType || 'application/octet-stream';
    // Force a download for anything not safe to render inline in our own origin
    // (HTML/SVG/etc. would otherwise be same-origin XSS when opened directly).
    const attach = query.disposition === 'attachment' || !inlineSafe(ct);
    const range = parseRange(req.headers.get('range'));

    // Ranged requests must proxy (we can't add Range to a bare redirect safely
    // for all clients), so only redirect for full-file GETs.
    if (!range) {
      const d = await node.download({ download: attach });
      if (d.mode === 'redirect') return Response.redirect(d.url, 302);
    }

    const { stream, size, contentType, etag, range: served } = await node.read({ range });
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

  // Mint URLs that carry their own authorization, for the things that cannot send a
  // header. Batched on purpose: a gallery draws hundreds of tiles, and per-object
  // signing is right for scoping but hopeless as one round trip each.
  //
  // Every id is authorized individually — the batch is a transport convenience, never a
  // widening. An id the caller may not read is simply absent from the answer, with its
  // reason alongside, so a partly-visible batch still returns the visible part.
  r.post('/api/items/urls', [], async (ctx) => {
    const b = await body(ctx.req);
    const ids = Array.isArray(b.ids) ? b.ids.filter((i) => typeof i === 'string' && i) : [];
    if (!ids.length) throw TroveError.invalid('ids is required');
    if (ids.length > URL_MINT_BATCH) throw TroveError.invalid(`At most ${URL_MINT_BATCH} ids at a time`);
    const op = b.op === 'media' || b.op === 'download' ? b.op : 'download';
    const urls = {};
    const failed = {};
    for (const id of new Set(ids)) {
      try {
        const node = await ctx.access.node(id, 'read');
        const { url, expiresAt } = await node.mintUrl({ op, download: op === 'download' });
        urls[id] = { url, expiresAt };
      } catch (err) {
        failed[id] = err.code || 'internal';
      }
    }
    return { urls, failed, op };
  });

  // --- uploads ---------------------------------------------------------------

  r.post('/api/collections/:collection/uploads', ['collections', 'vfs'], async (ctx) => {
    const b = await body(ctx.req);
    if (!b.name) throw TroveError.invalid('name is required');
    const collection = await ctx.access.collection(scopedCollection(ctx), 'write');
    // An upload onto an encrypted collection is handed the collection's key, so the client
    // can seal the bytes before they reach the bucket. That key decrypts EVERYTHING in the
    // collection, which makes it a read capability however it arrives — and `write` does
    // not imply `read` here (only `admin` expands). Without this, a write-only API key,
    // which the key model explicitly supports, could ask for a plan for a one-byte file and
    // receive the means to decrypt the whole collection.
    //
    // Refused rather than quietly narrowed to a plaintext upload: silently storing in the
    // clear on a collection someone set up to be encrypted is the worse failure.
    await assertReadIfKeyed(ctx, b);
    return uploadDescriptor(await collection.createUpload({
      name: b.name, size: Number(b.size ?? 0), contentType: b.contentType,
      overwrite: b.overwrite === true,
    }));
  });

  // An upload spans several requests keyed only by an unguessable id, so each one
  // re-obtains the handle — which re-asserts `write` on the session's collection. A
  // grant revoked mid-upload stops the next part, which is the point.

  r.get('/api/uploads/:id/status', [], async (ctx) => (await ctx.access.upload(ctx.params.id)).status());

  r.post('/api/uploads/:id/parts/:n/sign', [], async (ctx) => {
    const upload = await ctx.access.upload(ctx.params.id);
    return { url: await upload.signPart(Number(ctx.params.n)) };
  });

  r.post('/api/uploads/:id/parts/:n/report', [], async (ctx) => {
    const upload = await ctx.access.upload(ctx.params.id);
    const b = await body(ctx.req);
    return upload.reportPart(Number(ctx.params.n), b.etag);
  });

  // Direct part upload — raw body streamed to storage.
  r.put('/api/uploads/:id/parts/:n', [], async (ctx) => {
    const upload = await ctx.access.upload(ctx.params.id);
    return json(await upload.uploadPart(Number(ctx.params.n), ctx.req.body ?? new Uint8Array(0)));
  });

  r.post('/api/uploads/:id/complete', [], async (ctx) => {
    const upload = await ctx.access.upload(ctx.params.id);
    const b = await body(ctx.req);
    return { node: await upload.complete(b.parts) };
  });

  r.delete('/api/uploads/:id', [], async (ctx) => {
    await (await ctx.access.upload(ctx.params.id)).abort();
    return { ok: true };
  });

  // --- search & indexing -----------------------------------------------------

  // Raw search: the query string is passed through as text, with NO transformer.
  //
  // Which means the `#tag` grammar does not apply here. `/api/capabilities` advertises a
  // searchPrompt telling people `#tag` narrows by tag, and against this endpoint that
  // degrades into a text search for the literal string "#tag" — no error, just quietly
  // different results. POST /api/query is the one that runs the transformer and is what
  // the workbench uses; this stays as the lower-level endpoint for callers that have
  // already resolved their own query.
  // Searching comes in two shapes, and which one you get is in the URL rather than in
  // the presence of a parameter. The flat route searches every collection the caller can
  // read; the scoped one searches exactly the collection it names.
  //
  // Two routes rather than `?collection=` because omitting a query parameter used to mean
  // "the whole drive" — a missing value silently choosing the broadest possible scope,
  // which is the same failure shape as the old `'default'` fallback pointing the other
  // way. Neither is something to arrive at by accident.
  const searchHandler = async (ctx) => {
    const { vfs, query } = ctx;
    if (!query.q) throw TroveError.invalid('q is required');
    const collectionIds = await readableCollectionIds(ctx, ctx.params?.collection);
    const results = await vfs.searchQuery(query.q, {
      mode: query.mode, limit: clampLimit(query.limit, 40),
      indexers: query.indexers ? query.indexers.split(',') : undefined,
      collectionIds,
    });
    return { query: query.q, results };
  };
  r.get('/api/search', ['collections', 'vfs'], searchHandler);
  r.get('/api/collections/:collection/search', ['collections', 'vfs'], searchHandler);

  // Unified query: a raw user string is run through the search transformer (default
  // parses `#tag` syntax; a plugged-in one may use an LLM), then dispatched. Returns
  // the results AND the `resolved` query (what was actually searched) so the client
  // can honestly show it.
  const queryHandler = async (ctx) => {
    const b = await body(ctx.req);
    if (typeof b.q !== 'string' || !b.q.trim()) throw TroveError.invalid('q is required');
    const collectionIds = await readableCollectionIds(ctx, ctx.params?.collection);
    const { results, resolved } = await ctx.vfs.query(b.q, {
      mode: b.mode, limit: clampLimit(b.limit, 40), collectionIds,
      // Which views this client can draw with, so the transformer can suggest one of
      // them. Passed through as-is — the transformer bounds it before use, and a client
      // that sends nonsense only fails to get a suggestion.
      views: Array.isArray(b.views) ? b.views : undefined,
    });
    return { query: b.q, results, resolved };
  };
  r.post('/api/query', ['collections', 'vfs'], queryHandler);
  r.post('/api/collections/:collection/query', ['collections', 'vfs'], queryHandler);

  // Drive-wide tag/property filter (the launcher's `#tag` / `#key:op:value`).
  const tagSearchHandler = async (ctx) => {
    const b = await body(ctx.req);
    const filters = Array.isArray(b.filters) ? b.filters : [];
    const collectionIds = await readableCollectionIds(ctx, ctx.params?.collection);
    const items = await ctx.vfs.findByTags(filters, {
      q: b.q, collectionIds, limit: clampLimit(b.limit, 100),
    });
    return { items };
  };
  r.post('/api/tags/search', ['collections', 'vfs'], tagSearchHandler);
  r.post('/api/collections/:collection/tags/search', ['collections', 'vfs'], tagSearchHandler);

  r.get('/api/indexers', ['vfs'], ({ vfs }) => ({ indexers: vfs.indexers.list() }));

  // Plugin indexers push a namespaced contribution here (semanticTexts / tags /
  // metadata; legacy documents/facet accepted). The namespace is the path param,
  // so a plugin can only ever write under its own id.
  // Push a contribution under a contributor namespace. TWO gates, because they answer
  // different questions: `write` on the collection says you may change this item at
  // all, and namespace ownership says you may speak AS this contributor. Without the
  // second, anyone who can write anywhere could overwrite `core.links` and quietly
  // break every backlink, or impersonate another plugin's index.
  r.post('/api/index/:indexerId', ['plugins'], async (ctx) => {
    const b = await body(ctx.req);
    if (!b.nodeId) throw TroveError.invalid('nodeId is required');
    await assertContributorOwned(ctx, ctx.params.indexerId);
    const node = await ctx.access.node(b.nodeId, 'write');
    return node.contribute(ctx.params.indexerId, {
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
      // Awaited, like every other call through `ctx.tasks`. Where the registry is a
      // Durable Object this returns a promise, and an unawaited one serialises to `{}`
      // — a client that adopted "the new task list" would replace it with nothing.
      tasks: await ctx.tasks.list({
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

  // Check the backing stores on demand, and answer with what was found rather than only
  // leaving issues behind — an admin who just pressed "Check storage" is owed the result
  // of the check they asked for.
  //
  // Origin comes from THIS request, which is the whole reason the on-demand version
  // exists alongside the scheduled one: a bucket policy may legitimately name a single
  // origin, and the origin that matters is the one browsers are actually using to reach
  // the drive. A cron firing can only fall back to a configured TROVE_PUBLIC_URL.
  r.post('/api/diagnostics/storage', ['collections', 'issues', 'storageCheck'], async (ctx) => {
    await requireWholeDrive(ctx, 'check the backing stores');
    return ctx.storageCheck.run({ origin: publicOrigin(ctx.req, ctx.config) });
  });

  // --- key rotation ----------------------------------------------------------
  //
  // Moving a collection onto a new key is admin work in the strict sense: it rewrites every
  // object in the collection and costs real money on a metered store. `requireHumanAdmin`
  // refuses a request arriving on an API key — a credential that could re-key a collection
  // could also make its contents unreadable to everyone else holding the old one.

  /** What a rotation would cost, before anyone starts one. */
  r.get('/api/collections/:collection/rotate/estimate', ['collections', 'vfs'], async (ctx) => {
    const collectionId = scopedCollection(ctx);
    await ctx.access.collection(collectionId, 'admin');
    requireHumanAdmin(ctx, 'estimate a key rotation');
    const record = await ctx.collections.get(collectionId);
    const stats = await ctx.vfs.metadata.collectionStats?.(collectionId).catch(() => null);
    return estimateRotationCost(
      { driver: record.store?.driver, endpoint: record.store?.endpoint || record.store?.s3?.endpoint },
      { objects: stats?.items ?? 0, bytes: stats?.bytes ?? 0 },
    );
  });

  r.get('/api/collections/:collection/rotate', ['collections', 'rotation'], async (ctx) => {
    const collectionId = scopedCollection(ctx);
    await ctx.access.collection(collectionId, 'admin');
    requireHumanAdmin(ctx, 'read key rotation state');
    // Null rather than 404: "this collection has never been rotated" is an answer, and a
    // client polling for progress should not have to treat it as an error.
    return { rotation: (await ctx.rotation.state(collectionId)) || null };
  });

  r.post('/api/collections/:collection/rotate', ['collections', 'rotation'], async (ctx) => {
    const collectionId = scopedCollection(ctx);
    await ctx.access.collection(collectionId, 'admin');
    requireHumanAdmin(ctx, 'rotate a key');
    // Begin only mints the key and makes it current; the objects move in slices, from the
    // cron or from further calls. Returning immediately is the point — the walk can take
    // hours and holding the request open for it would just time out.
    const state = await ctx.rotation.begin(collectionId, ctx.principal);
    return { rotation: state };
  });

  r.delete('/api/collections/:collection/rotate', ['collections', 'rotation'], async (ctx) => {
    const collectionId = scopedCollection(ctx);
    await ctx.access.collection(collectionId, 'admin');
    requireHumanAdmin(ctx, 'cancel a key rotation');
    // Stops the walk. What has already moved stays moved, and both keys stay in the ring,
    // so nothing becomes unreadable — an abandoned rotation is untidy, not destructive.
    return { rotation: await ctx.rotation.cancel(collectionId) };
  });

  // Rebuild the search index on demand. Admin-only: it re-reads every object in the
  // drive, so it is a real load, and it is drive-wide rather than scoped to anything
  // the caller owns. Returns the task, which is how the caller watches it.
  r.post('/api/reindex', ['backgroundWork', 'collections', 'tasks'], async (ctx) => {
    await requireWholeDrive(ctx, 'rebuild the search index');
    if (!ctx.backgroundWork) throw TroveError.unsupported('Reindexing is not available on this deployment');
    // Two concurrent full rebuilds would double the work to reach the same place, so
    // `beginReindex` claims the drive first and says whether it got it. The claim is
    // shared state rather than this process's task list — the other rebuild may be in
    // another isolate, and a check that can only see local memory would not find it.
    const { task, alreadyRunning } = await ctx.backgroundWork.beginReindex({ reason: 'Started manually' });
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

  r.get('/api/collections/:collection/trash', [], async (ctx) => {
    const collectionId = scopedCollection(ctx);
    const collection = await ctx.access.collection(collectionId, 'delete');
    return { items: await collection.listTrash({ limit: clampLimit(ctx.query.limit, 200) }), collectionId };
  });

  r.post('/api/trash/restore', [], async (ctx) => {
    const b = await body(ctx.req);
    if (!b.id) throw TroveError.invalid('id is required');
    // `trashed` — the item is out of the drive, which is the only reason to restore it.
    const node = await ctx.access.node(b.id, 'delete', { trashed: true });
    return { node: await node.restore() };
  });

  // Destroy for real. Separate from DELETE /api/items so that emptying the trash can
  // never be something you reach by accident from the ordinary delete path.
  // One item, by id. The node names its own collection, so this stays flat.
  r.post('/api/trash/purge', [], async (ctx) => {
    const b = await body(ctx.req);
    if (!b.id) throw TroveError.invalid('id is required — to empty a collection\u2019s trash, use /api/collections/:collection/trash/purge');
    const node = await ctx.access.node(b.id, 'delete', { trashed: true });
    await node.remove({ permanent: true });
    return { purged: 1 };
  });

  // Empty a whole collection's trash. Scoped by path, because "everything in here" is
  // exactly the request that must never be able to mean a collection you did not name.
  r.post('/api/collections/:collection/trash/purge', [], async (ctx) => {
    const collection = await ctx.access.collection(scopedCollection(ctx), 'delete');
    return collection.purgeTrash({ limit: MAX_PAGE });
  });

  // Reconcile a collection against the bytes actually in its store — how files added,
  // replaced, or removed by anything other than Trove get noticed. Needs `write` on the
  // collection, because a scan can create items in it.
  r.post('/api/collections/:id/scan', ['backgroundWork', 'tasks'], async (ctx) => {
    await ctx.access.collection(ctx.params.id, 'write');
    if (!ctx.backgroundWork) throw TroveError.unsupported('Scanning is not available on this deployment');
    const { task, alreadyRunning } = await ctx.backgroundWork.beginScan(ctx.params.id, { reason: 'Started manually' });
    if (alreadyRunning) {
      const local = (await ctx.tasks.list())
        .find((t) => t.kind === 'scan' && t.collectionId === ctx.params.id && t.status === 'running');
      return { task: local || null, alreadyRunning: true };
    }
    return { task };
  });

  // --- identity --------------------------------------------------------------

  r.get('/api/me', ['collections'], (ctx) => ({
    principal: ctx.principal || null,
    // Authenticated means SOMEONE signed in — not merely that a principal object
    // exists. The shared anonymous user is a stand-in for "no identity configured", and
    // reporting it as authenticated would have the client show a profile for nobody.
    authenticated: !!ctx.principal && !ctx.principal.anonymous,
    // From config like every other answer about the ACL layer. This one only decides
    // which UI the client offers — the routes enforce regardless — but a `collections`
    // that went missing would tell every visitor they were an administrator, which is
    // a worse lie than an error.
    admin: collectionsEnabled(ctx) ? ctx.collections.isAdmin(ctx.principal) : !!ctx.principal,
  }));

  // --- conversations, tags, sidecar (per file) -------------------------------
  // The :id is a file node id; the sidecar is that file's CRDT document.

  r.get('/api/items/:id/sidecar', [], async (ctx) => {
    // The handle is the sidecar for this node: obtaining it resolved the node
    // (404 if gone) and asserted `read` on its collection.
    return (await ctx.access.node(ctx.params.id, 'read')).view();
  });

  r.post('/api/items/:id/comments', [], async (ctx) => {
    requirePrincipal(ctx.principal);
    const node = await ctx.access.node(ctx.params.id, 'write');
    const b = await body(ctx.req);
    return { comment: await node.comment({ body: b.body, parentId: b.parentId, mentions: b.mentions }, ctx.principal) };
  });

  r.post('/api/items/:id/comments/:cid/edit', [], async (ctx) => {
    requirePrincipal(ctx.principal);
    const node = await ctx.access.node(ctx.params.id, 'write'); // + authorship checked in the service
    const b = await body(ctx.req);
    return { comment: await node.editComment(ctx.params.cid, b.body, ctx.principal) };
  });

  r.delete('/api/items/:id/comments/:cid', [], async (ctx) => {
    requirePrincipal(ctx.principal);
    const node = await ctx.access.node(ctx.params.id, 'write'); // + authorship checked in the service
    return node.deleteComment(ctx.params.cid, ctx.principal);
  });

  r.post('/api/items/:id/comments/:cid/react', [], async (ctx) => {
    requirePrincipal(ctx.principal);
    const node = await ctx.access.node(ctx.params.id, 'write');
    const b = await body(ctx.req);
    if (!b.emoji) throw TroveError.invalid('emoji is required');
    return { comment: await node.react(ctx.params.cid, b.emoji, b.on !== false, ctx.principal) };
  });

  r.post('/api/items/:id/tags', [], async (ctx) => {
    const node = await ctx.access.node(ctx.params.id, 'write');
    const b = await body(ctx.req);
    if (!b.name) throw TroveError.invalid('name is required');
    // The façade sets the CRDT tag AND its queryable mirror together (no swallow).
    return node.setTag(b.name, b.value, ctx.principal);
  });

  r.delete('/api/items/:id/tags/:name', [], async (ctx) => {
    // Removing a tag is a write — a read handle has no removeTag, so a read-only
    // user cannot strip tags off files they cannot modify.
    const node = await ctx.access.node(ctx.params.id, 'write');
    return node.removeTag(ctx.params.name, ctx.principal);
  });

  r.post('/api/items/:id/subscribe', [], async (ctx) => {
    requirePrincipal(ctx.principal);
    const node = await ctx.access.node(ctx.params.id, 'read');
    const b = await body(ctx.req);
    return node.subscribe(ctx.principal, !!b.muted);
  });
  r.delete('/api/items/:id/subscribe', [], async (ctx) => {
    requirePrincipal(ctx.principal);
    const node = await ctx.access.node(ctx.params.id, 'read');
    return node.unsubscribe(ctx.principal);
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

  // /api/push/* is not here. Registering with a delivery channel is the channel's own
  // business — see WebPushChannel.routes() — so the drive's route table does not carry
  // endpoints for a transport it may not have configured, and adding email or chat does
  // not mean editing this file.

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
    await plugins.assertCapability(principal, params.pluginId, 'storage');
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
      await plugins.assertSharedStorage(principal, params.pluginId);
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
    await plugins.assertCapability(principal, params.pluginId, 'storage');
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
  // No presence check. `plugins` is always built — there is no configuration that
  // switches it off — so `if (!ctx.plugins) return` guarded a condition that could
  // not occur, and the only thing it ever did was fail OPEN when the wiring was
  // wrong: this check silently became a no-op and any authenticated caller could
  // contribute under any vendor's name. Enforcement decides from configuration,
  // never from whether an object happens to be here; a missing service throws.
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
  if (!collectionsEnabled(ctx)) return undefined;
  // A NAMED collection is asserted, not filtered. Filtering an unreadable id out of the
  // list answers "no results" for a collection the caller may not see — indistinguishable
  // from one that is simply empty, so a permissions problem reads as an indexing problem.
  // `access.collection` throws the 403 that says what actually happened.
  if (narrowTo) {
    await ctx.access.collection(narrowTo, 'read');
    return [narrowTo];
  }
  return (await ctx.collections.list(ctx.principal)).map((c) => c.id);
}

/**
 * Whether this deployment has an ACL layer at all.
 *
 * Read from configuration, not from whether `ctx.collections` is truthy. The two
 * agree when everything is wired correctly, and diverge exactly when it is not —
 * and a security check that stands down because a service is missing is one that
 * stops enforcing at the worst possible moment. Configuration says whether to
 * enforce; the service does the enforcing, and if it is absent this throws.
 */
const collectionsEnabled = (ctx) => ctx.config?.collections !== false;

/**
 * Managing collections is only meaningful where there is an ACL layer to manage.
 *
 * From config, not from `ctx.collections` being null — the two agree today only
 * because the provider derives one from the other, and a build failure would make
 * "Collections are not enabled" a lie about a drive that has them.
 */
function requireCollections(ctx) {
  if (!collectionsEnabled(ctx)) throw TroveError.unsupported('Collections are not enabled');
}

async function assertCap(ctx, collectionId, capability) {
  if (!collectionsEnabled(ctx)) return; // no ACL layer configured
  await ctx.collections.assert(ctx.principal, collectionId, capability);
}

/**
 * Gate an operation that acts on the whole drive rather than on anything the caller
 * owns — rebuilding the index, cancelling someone else's task. See
 * CollectionService.hasWholeDrive for why this isn't plain `isAdmin`.
 */
async function requireWholeDrive(ctx, what) {
  const allowed = collectionsEnabled(ctx)
    ? await ctx.collections.hasWholeDrive(ctx.principal)
    : !!ctx.principal;
  if (!allowed) throw TroveError.forbidden(`You do not have permission to ${what}`);
}
const canWholeDrive = (ctx) =>
  (collectionsEnabled(ctx)
    ? ctx.collections.hasWholeDrive(ctx.principal)
    : Promise.resolve(!!ctx.principal));

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
/**
 * An admin, in person.
 *
 * Two refusals, not one. A grant is refused outright — an API key must never be able to
 * manage API keys, however broadly it was scoped, because a key that can mint keys can
 * outlive its own revocation. Then the ordinary admin check on the principal.
 */

/**
 * An upload plan that will carry the collection key needs `read`, not merely `write`.
 *
 * Checked before the session is created, so a refusal costs nothing and leaves no orphan.
 */
async function assertReadIfKeyed(ctx, body) {
  if (!ctx.collections?.encryptionFor) return;
  const collectionId = scopedCollection(ctx);
  const encryption = await ctx.collections.encryptionFor(collectionId);
  if (!encryption?.enabled) return;
  const contentType = body.contentType || ctx.vfs?.guessContentType?.(body.name) || '';
  if (!shouldEncrypt(encryption, { name: body.name, contentType })) return;
  // Throws if the caller does not hold read on this collection.
  await ctx.access.collection(collectionId, 'read');
}

function requireHumanAdmin(ctx, action) {
  if (ctx.grant) {
    throw TroveError.forbidden(`An API key cannot ${action} — sign in as an administrator`);
  }
  requirePrincipal(ctx.principal);
  const isAdmin = collectionsEnabled(ctx) ? ctx.collections.isAdmin(ctx.principal) : !!ctx.principal;
  if (!isAdmin) throw TroveError.forbidden(`You need to be an administrator to ${action}`);
}

function requirePrincipal(principal) {
  if (!principal) throw TroveError.unauthorized('Authentication required');
}
function requireNotifications(n) {
  if (!n) throw TroveError.unsupported('Notifications are not enabled on this server');
}

/**
 * The request plumbing handed to routes contributed from outside this file.
 *
 * `body` is the capped JSON read — the cap is the reason to share it rather than let a
 * channel call `req.json()` and accept an unbounded body — and `requirePrincipal` is
 * the same 401 every route here throws.
 */
export const routeHelpers = { body, requirePrincipal };
