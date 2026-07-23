// Vfs — the façade the server talks to. It binds the three pluggable pieces
// (storage blobs, metadata tree, search) into coherent, user-level operations:
// list/stat/mkdir/read/write/move/delete/search and the upload lifecycle. It's
// where indexing is triggered (on write/complete) and where download URLs are
// resolved to a presigned link when the backend supports it (so big downloads
// bypass our server) or a proxied stream when it doesn't.
//
// Nothing here is HTTP-aware; the server package adapts these methods to routes.

import { TroveError } from './errors.js';
import { UploadManager } from './uploads.js';
import { IndexerRegistry, textIndexer } from './indexers/registry.js';
import { basename, parentPath, extname } from './util.js';
import { ROOT_ID } from './metadata/memory.js';

const CONTENT_TYPES = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.json': 'application/json', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4', '.opus': 'audio/opus', '.flac': 'audio/flac', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.zip': 'application/zip',
};

export class Vfs {
  /**
   * @param {object} deps
   * @param {import('./storage/interface.js').StorageBackend} deps.storage
   * @param {import('./metadata/interface.js').MetadataStore} deps.metadata
   * @param {import('./search/index.js').SearchService} [deps.search]
   * @param {IndexerRegistry} [deps.indexers]
   * @param {number} [deps.maxIndexBytes] cap on bytes read for content indexing
   */
  constructor({ storage, metadata, search, indexers, maxIndexBytes = 2 * 1024 * 1024 }) {
    if (!storage) throw TroveError.invalid('Vfs requires a storage backend');
    if (!metadata) throw TroveError.invalid('Vfs requires a metadata store');
    this.storage = storage;
    this.metadata = metadata;
    this.search = search ?? null;
    this.indexers = indexers ?? new IndexerRegistry();
    if (!this.indexers.indexers.size) this.indexers.register(textIndexer);
    this.uploads = new UploadManager({ storage });
    this.maxIndexBytes = maxIndexBytes;
  }

  async init() {
    await this.metadata.init();
  }

  guessContentType(name) {
    return CONTENT_TYPES[extname(name)] || 'application/octet-stream';
  }

  // --- reads -----------------------------------------------------------------

  async resolve(pathOrId) {
    const node = pathOrId.startsWith('/')
      ? await this.metadata.getByPath(pathOrId)
      : await this.metadata.getById(pathOrId);
    if (!node) throw TroveError.notFound('File or folder');
    return node;
  }

  async list(pathOrId, opts) {
    const node = await this.resolve(pathOrId);
    if (node.kind !== 'folder') throw TroveError.invalid('Not a folder');
    return this.metadata.listChildren(node.id, opts);
  }

  async stat(pathOrId) {
    return this.resolve(pathOrId);
  }

  /** Path from root to node (for breadcrumbs). */
  async breadcrumb(id) {
    const trail = [];
    let cur = await this.metadata.getById(id);
    while (cur) {
      trail.unshift({ id: cur.id, name: cur.name, path: cur.path });
      cur = cur.parentId ? await this.metadata.getById(cur.parentId) : null;
    }
    return trail;
  }

  // --- mutations -------------------------------------------------------------

  async mkdir(parentId, name) {
    const parent = await this.resolve(parentId);
    return this.metadata.create({ parentId: parent.id, name, kind: 'folder' });
  }

  /** Convenience whole-file write (used for small files / server-side writes). */
  async writeFile(parentId, name, body, { contentType, signal } = {}) {
    const parent = await this.resolve(parentId);
    const storageKey = `obj_${cryptoId()}`;
    const ct = contentType || this.guessContentType(name);
    const info = await this.storage.put(storageKey, body, { contentType: ct, signal });
    const node = await this.#upsertFileNode({
      parentId: parent.id, name, storageKey, size: info.size, contentType: ct, etag: info.etag,
    });
    this.#indexNode(node).catch((e) => console.error('index error', e));
    return node;
  }

  /** Create-or-overwrite a file node at (parentId, name). */
  async #upsertFileNode({ parentId, name, storageKey, size, contentType, etag }) {
    const existing = await this.metadata.getByPath(pathOf(await this.metadata.getById(parentId), name));
    if (existing && existing.kind === 'file') {
      const oldKey = existing.storageKey;
      const updated = await this.metadata.update(existing.id, { storageKey, size, contentType, etag });
      if (oldKey && oldKey !== storageKey) await this.storage.delete(oldKey).catch(() => {});
      return updated;
    }
    if (existing) throw TroveError.alreadyExists(name);
    return this.metadata.create({ parentId, name, kind: 'file', storageKey, size, contentType, etag });
  }

  async move(id, destParentId, newName) {
    const node = await this.resolve(id);
    if (node.id === ROOT_ID) throw TroveError.invalid('Cannot move the root');
    return this.metadata.move(node.id, destParentId, newName);
  }

  async rename(id, newName) {
    const node = await this.resolve(id);
    return this.metadata.move(node.id, node.parentId, newName);
  }

  async remove(id, { recursive = true } = {}) {
    const node = await this.resolve(id);
    if (node.id === ROOT_ID) throw TroveError.invalid('Cannot delete the root');
    if (node.kind === 'folder') {
      const kids = await this.metadata.descendants(node.id);
      if (kids.length && !recursive) throw TroveError.invalid('Folder is not empty');
      // Delete children (files first: reclaim blobs), then the folder.
      for (const child of kids) {
        if (child.kind === 'file' && child.storageKey) {
          await this.storage.delete(child.storageKey).catch(() => {});
        }
        await this.search?.removeNode(child.id);
        await this.metadata.remove(child.id);
      }
    } else if (node.storageKey) {
      await this.storage.delete(node.storageKey).catch(() => {});
    }
    await this.search?.removeNode(node.id);
    await this.metadata.remove(node.id);
    return { ok: true };
  }

  // --- download --------------------------------------------------------------

  /**
   * Resolve how the client should fetch a file:
   *   { mode: 'redirect', url }  — presigned; client GETs S3 directly.
   *   { mode: 'proxy', node }    — caller streams bytes via readStream().
   */
  async getDownload(id, { expiresIn, download } = {}) {
    const node = await this.resolve(id);
    if (node.kind !== 'file') throw TroveError.invalid('Not a file');
    if (this.storage.capabilities.presignDownload) {
      const url = await this.storage.presignGet(node.storageKey, {
        expiresIn,
        responseContentType: node.contentType,
        downloadName: download ? node.name : undefined,
      });
      return { mode: 'redirect', url, node };
    }
    return { mode: 'proxy', node };
  }

  /** Byte stream for proxying (fs/memory backends, or range requests). */
  async readStream(id, { range, signal } = {}) {
    const node = await this.resolve(id);
    if (node.kind !== 'file') throw TroveError.invalid('Not a file');
    if (!node.storageKey) throw TroveError.notFound('File content');
    return this.storage.get(node.storageKey, { range, signal });
  }

  // --- uploads ---------------------------------------------------------------

  async createUpload(req) {
    const parent = await this.resolve(req.parentId);
    return this.uploads.create({ ...req, parentId: parent.id, contentType: req.contentType || this.guessContentType(req.name) });
  }
  signUploadPart(uploadId, partNumber) {
    return this.uploads.signPart(uploadId, partNumber);
  }
  reportUploadPart(uploadId, partNumber, etag) {
    return this.uploads.reportPart(uploadId, partNumber, etag);
  }
  uploadPart(uploadId, partNumber, body, opts) {
    return this.uploads.uploadPart(uploadId, partNumber, body, opts);
  }
  uploadStatus(uploadId) {
    return this.uploads.status(uploadId);
  }
  abortUpload(uploadId) {
    return this.uploads.abort(uploadId);
  }

  async completeUpload(uploadId, parts) {
    const obj = await this.uploads.complete(uploadId, parts);
    const node = await this.#upsertFileNode(obj);
    this.#indexNode(node).catch((e) => console.error('index error', e));
    return node;
  }

  // --- search & indexing -----------------------------------------------------

  async searchQuery(query, opts) {
    if (!this.search) {
      // Fall back to name search via metadata when no SearchService is wired.
      const items = await this.metadata.searchByName(query, opts);
      return items.map((n) => ({ nodeId: n.id, score: 1, node: n, snippet: null }));
    }
    const results = await this.search.search(query, opts);
    // Hydrate nodes for the UI.
    const out = [];
    for (const r of results) {
      const node = await this.metadata.getById(r.nodeId);
      if (node) out.push({ ...r, node });
    }
    return out;
  }

  /** Push documents from a (plugin) indexer under its namespace onto a node. */
  async indexDocuments(nodeId, indexerId, documents, facet) {
    const node = await this.metadata.getById(nodeId);
    if (!node) throw TroveError.notFound('Node');
    if (this.search) await this.search.indexDocuments(nodeId, indexerId, documents);
    if (facet) await this.metadata.setFacet(nodeId, indexerId, facet);
    return { ok: true };
  }

  async #indexNode(node) {
    if (node.kind !== 'file') return;
    if (this.search) await this.search.indexName(node);
    const matching = this.indexers.matching(node);
    for (const indexer of matching) {
      try {
        const ctx = {
          maxBytes: this.maxIndexBytes,
          readBytes: async () => {
            const { stream } = await this.storage.get(node.storageKey, { range: { start: 0, end: this.maxIndexBytes - 1 } });
            return readAll(stream);
          },
          readText: async () => {
            const { stream } = await this.storage.get(node.storageKey, { range: { start: 0, end: this.maxIndexBytes - 1 } });
            return new TextDecoder().decode(await readAll(stream));
          },
        };
        const { documents, facet } = await indexer.index(node, ctx);
        if (this.search && documents) await this.search.indexDocuments(node.id, indexer.id, documents);
        if (facet) await this.metadata.setFacet(node.id, indexer.id, facet);
      } catch (err) {
        console.error(`indexer ${indexer.id} failed on ${node.path}:`, err.message);
      }
    }
  }
}

function pathOf(parent, name) {
  return parent.path === '/' ? `/${name}` : `${parent.path}/${name}`;
}
function cryptoId() {
  return (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, '');
}
async function readAll(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export { CONTENT_TYPES };
