// The Trove HTTP API, mapped onto Vfs methods. JSON in/out except downloads
// (bytes, range-aware) and direct part uploads (raw body). Downloads redirect to
// a presigned URL when the backend supports it, otherwise stream through here.

import { Router, json, parseRange } from './router.js';
import { TroveError } from '@trove/core';

async function body(req) {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw TroveError.invalid('Body must be valid JSON');
  }
}

// Accept either ?path=/x or ?id=... ; body may carry parentId or parentPath.
async function resolveParent(vfs, src) {
  if (src.parentId) return src.parentId;
  if (src.parentPath) return (await vfs.stat(src.parentPath)).id;
  return 'root';
}

export function createRouter() {
  const r = new Router();

  r.get('/api/health', () => ({ ok: true, service: 'trove', time: Date.now() }));

  r.get('/api/capabilities', ({ vfs, config }) => ({
    storage: vfs.storage.capabilities,
    indexers: vfs.indexers.list(),
    partSize: vfs.uploads.partSize,
    features: { semanticSearch: !!vfs.search },
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

  // --- browse ----------------------------------------------------------------

  r.get('/api/fs/list', async ({ vfs, query }) => {
    const pathOrId = query.id || query.path || '/';
    const node = await vfs.stat(pathOrId);
    const { items, nextCursor } = await vfs.list(node.id, {
      sort: query.sort, order: query.order,
      limit: query.limit ? Number(query.limit) : undefined,
      cursor: query.cursor,
    });
    const breadcrumb = await vfs.breadcrumb(node.id);
    return { node, items, nextCursor, breadcrumb };
  });

  r.get('/api/fs/stat', async ({ vfs, query }) => {
    const node = await vfs.stat(query.id || query.path);
    return { node, breadcrumb: await vfs.breadcrumb(node.id) };
  });

  r.post('/api/fs/folder', async ({ vfs, req }) => {
    const b = await body(req);
    if (!b.name) throw TroveError.invalid('name is required');
    return { node: await vfs.mkdir(await resolveParent(vfs, b), b.name) };
  });

  r.post('/api/fs/move', async ({ vfs, req }) => {
    const b = await body(req);
    if (!b.id) throw TroveError.invalid('id is required');
    const destParentId = b.destParentId || (b.destParentPath ? (await vfs.stat(b.destParentPath)).id : undefined);
    if (!destParentId) throw TroveError.invalid('destParentId is required');
    return { node: await vfs.move(b.id, destParentId, b.newName) };
  });

  r.post('/api/fs/rename', async ({ vfs, req }) => {
    const b = await body(req);
    if (!b.id || !b.newName) throw TroveError.invalid('id and newName are required');
    return { node: await vfs.rename(b.id, b.newName) };
  });

  r.post('/api/fs/delete', async ({ vfs, req }) => {
    const b = await body(req);
    if (!b.id) throw TroveError.invalid('id is required');
    return vfs.remove(b.id, { recursive: b.recursive !== false });
  });

  // --- download (presign redirect or range-aware proxy) ----------------------

  r.get('/api/fs/download', async ({ vfs, query, req }) => {
    const id = query.id;
    if (!id) throw TroveError.invalid('id is required');
    const wantAttachment = query.disposition === 'attachment';
    const range = parseRange(req.headers.get('range'));

    // Ranged requests must proxy (we can't add Range to a bare redirect safely
    // for all clients), so only redirect for full-file GETs.
    if (!range) {
      const d = await vfs.getDownload(id, { download: wantAttachment });
      if (d.mode === 'redirect') return Response.redirect(d.url, 302);
    }

    const node = await vfs.stat(id);
    const { stream, size, contentType, etag, range: served } = await vfs.readStream(id, { range });
    const headers = {
      'content-type': contentType || node.contentType || 'application/octet-stream',
      'accept-ranges': 'bytes',
      'content-length': String(size),
      ...(etag ? { etag } : {}),
      'content-disposition': `${wantAttachment ? 'attachment' : 'inline'}; filename="${encodeURIComponent(node.name)}"`,
      'cache-control': 'private, max-age=0',
    };
    if (served) {
      headers['content-range'] = `bytes ${served.start}-${served.end}/${served.total}`;
      return new Response(stream, { status: 206, headers });
    }
    return new Response(stream, { status: 200, headers });
  });

  // --- uploads ---------------------------------------------------------------

  r.post('/api/uploads', async ({ vfs, req }) => {
    const b = await body(req);
    if (!b.name) throw TroveError.invalid('name is required');
    const plan = await vfs.createUpload({
      parentId: await resolveParent(vfs, b),
      name: b.name, size: Number(b.size ?? 0), contentType: b.contentType,
    });
    return plan;
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

  r.get('/api/search', async ({ vfs, query }) => {
    if (!query.q) throw TroveError.invalid('q is required');
    const results = await vfs.searchQuery(query.q, {
      mode: query.mode, limit: query.limit ? Number(query.limit) : undefined,
      indexers: query.indexers ? query.indexers.split(',') : undefined,
    });
    return { query: query.q, results };
  });

  r.get('/api/indexers', ({ vfs }) => ({ indexers: vfs.indexers.list() }));

  // Plugin indexers push namespaced documents/facets here. The namespace is the
  // path param, so a plugin can only ever write under its own id.
  r.post('/api/index/:indexerId', async ({ vfs, params, req }) => {
    const b = await body(req);
    if (!b.nodeId) throw TroveError.invalid('nodeId is required');
    return vfs.indexDocuments(b.nodeId, params.indexerId, b.documents || [], b.facet);
  });

  return r;
}
