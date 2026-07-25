// ngin Actions — the workbench's business logic as thin, dispatchable verbs
// (CQRS-style). Each depends on the `app` provider (platform + reactive
// services) and performs one user intent: navigate, mutate the tree, upload,
// search, open a file. Errors surface as notifications; the reactive services
// they update flow straight back into the UI via `watch`.

import { Action } from '@3sln/ngin';
import { newId } from '@trove/core/util.js';
import { matchesTagFilters } from './tagQuery.js';
import { availableOpeners, rememberedOpenerId } from './openers.js';

class AppAction extends Action {
  static deps = ['app'];
}

export class NavigateAction extends AppAction {
  constructor(target, collectionId) {
    super();
    this.target = target; // folder id or '/path'
    this.collectionId = collectionId; // set to switch collections (navigates to its root)
  }
  async execute({ app }) {
    const { explorer, platform } = app;
    const collectionId = this.collectionId || explorer.state.collectionId || 'default';
    const target = this.collectionId ? '/' : this.target ?? '/';
    explorer.set({ loading: true, error: null, collectionId });
    try {
      const sort = platform.settings.get('explorer.sort');
      const order = platform.settings.get('explorer.sortOrder');
      const res = await platform.api.list(target, { sort, order, collection: collectionId });
      explorer.set({
        folder: res.node, breadcrumb: res.breadcrumb, items: res.items,
        loading: false, selection: [], sort, order, collectionId: res.collectionId || collectionId,
      });
      // Explorer→context projection (folderId/collectionId/hasSelection) lives in
      // bl/index.js so it stays in sync with selection too — nothing to mirror here.
    } catch (err) {
      explorer.set({ loading: false, error: err.message });
      platform.notifications.error(`Couldn't open folder: ${err.message}`);
    }
  }
}

export class LoadCollectionsAction extends AppAction {
  async execute({ app }) {
    try {
      const res = await app.platform.api.collections();
      app.explorer.set({ collections: res.collections || [], canCreateCollection: !!res.canCreate });
    } catch { /* collections disabled */ }
  }
}

export class CreateCollectionAction extends AppAction {
  constructor(record) {
    super();
    this.record = record;
  }
  async execute({ app }) {
    try {
      const res = await app.platform.api.createCollection(this.record);
      app.platform.notifications.success(`Created collection “${res.collection.name}”`);
      await app.engine.dispatch(new LoadCollectionsAction());
      app.engine.dispatch(new NavigateAction('/', res.collection.id));
    } catch (err) {
      app.platform.notifications.error(`Couldn’t create collection: ${err.message}`);
    }
  }
}

export class RefreshAction extends AppAction {
  async execute({ app }) {
    const id = app.explorer.state.folder?.id ?? '/';
    return app.engine.dispatch(new NavigateAction(id));
  }
}

export class CreateFolderAction extends AppAction {
  constructor(name) {
    super();
    this.name = name;
  }
  async execute({ app }) {
    const parentId = app.explorer.state.folder?.id ?? 'root';
    try {
      await app.platform.api.mkdir(parentId, this.name);
      app.platform.notifications.success(`Created folder "${this.name}"`);
      app.engine.dispatch(new NavigateAction(parentId));
    } catch (err) {
      app.platform.notifications.error(`Couldn’t create folder: ${err.message}`);
    }
  }
}

export class DeleteAction extends AppAction {
  constructor(ids) {
    super();
    this.ids = ids;
  }
  async execute({ app }) {
    try {
      for (const id of this.ids) await app.platform.api.remove(id, true);
      app.platform.notifications.info(`Deleted ${this.ids.length} item${this.ids.length > 1 ? 's' : ''}`);
      for (const id of this.ids) app.platform.workbench.closeTab(id);
    } catch (err) {
      app.platform.notifications.error(`Couldn’t delete: ${err.message}`);
    }
    app.engine.dispatch(new RefreshAction());
  }
}

export class RenameAction extends AppAction {
  constructor(id, newName) {
    super();
    this.id = id;
    this.newName = newName;
  }
  async execute({ app }) {
    try {
      const node = await app.platform.api.rename(this.id, this.newName);
      app.platform.workbench.updateTabNode(node.node);
      app.engine.dispatch(new RefreshAction());
    } catch (err) {
      app.platform.notifications.error(`Couldn’t rename: ${err.message}`);
    }
  }
}


export class OpenFileAction extends AppAction {
  /** @param {object} node @param {{reset?:boolean}} [opts] reset → start a fresh stack (modal search) */
  constructor(node, opts = {}) {
    super();
    this.node = node;
    this.opts = opts;
  }
  async execute({ app }) {
    // Guard against being invoked with no target (e.g. a command fired with an empty
    // selection) — dereferencing a null node would throw an unhandled rejection.
    if (!this.node) return;
    if (this.node.kind === 'folder') return app.engine.dispatch(new NavigateAction(this.node.id));
    const { platform } = app;
    const open = (openerId) => platform.workbench.openFile(this.node, openerId, { reset: !!this.opts.reset });

    // An explicit opener (e.g. the switch-opener control) wins outright.
    if (this.opts.openerId) return open(this.opts.openerId);

    // Only openers available right now (a plugin previewer needing the network while
    // offline is skipped, so we fall back to a built-in one).
    const avail = availableOpeners(platform, this.node);

    // A remembered choice for this file type, if that opener is still available.
    const remembered = rememberedOpenerId(platform, this.node);
    if (remembered && avail.some((o) => o.id === remembered)) return open(remembered);

    // Several openers and no saved preference → let the user choose (with an option to
    // remember). One or none → just open the best (or the download fallback).
    if (avail.length > 1) {
      return platform.workbench.showDialog({ kind: 'opener-chooser', node: this.node, openers: avail, reset: !!this.opts.reset });
    }
    open(avail[0]?.id || 'core.fallback');
  }
}

export class UploadFilesAction extends AppAction {
  constructor(files, parentId) {
    super();
    this.files = files;
    this.parentId = parentId;
  }
  async execute({ app }) {
    const parentId = this.parentId || app.explorer.state.folder?.id || 'root';
    const concurrency = app.platform.settings.get('uploads.concurrency');
    const uploads = [...this.files].map((file) => this.#one(app, file, parentId, concurrency));
    await Promise.allSettled(uploads);
    app.engine.dispatch(new NavigateAction(parentId));
  }
  async #one(app, file, parentId, concurrency) {
    const { transfers, platform } = app;
    const tid = newId('xfer');
    const controller = new AbortController();
    transfers.start(tid, file.name, file.size, controller);
    let uploadId = null;
    try {
      const node = await platform.api.upload(file, {
        parentId, concurrency, signal: controller.signal,
        onStart: (id) => { uploadId = id; },
        onProgress: (p) => transfers.progress(tid, p),
      });
      transfers.finish(tid, 'done');
      // The server disambiguates a same-name collision rather than overwriting — tell
      // the user when the saved name differs from what they dropped.
      if (node?.name && node.name !== file.name) {
        platform.notifications.info(`"${file.name}" already existed — saved as "${node.name}".`);
      }
    } catch (err) {
      // Release the server-side session so a cancelled/failed multipart upload doesn't
      // leak an open multipart object (best-effort; the server also sweeps stale ones).
      if (uploadId) platform.api.abortUpload(uploadId).catch(() => {});
      if (err.code === 'aborted') transfers.finish(tid, 'cancelled');
      else {
        transfers.finish(tid, 'error', err.message);
        platform.notifications.error(`Upload failed: ${file.name} — ${err.message}`);
      }
    }
  }
}

/** Drive-wide tag/property filter (`#tag`, `#key:op:value`), optionally narrowed
 *  by free text. Falls back to filtering the loaded folder when offline. */
export class FilterAction extends AppAction {
  constructor(filters, text) {
    super();
    this.filters = filters || [];
    this.text = text || '';
  }
  async execute({ app }) {
    const { search, platform } = app;
    if (!this.filters.length) {
      search.set({ results: [], ran: false, filtered: false });
      return;
    }
    search.set({ query: this.text, loading: true, error: null, filtered: true });
    if (app.offline && !app.offline.state.online) {
      const items = (app.explorer.state.items || []).filter((n) => n.kind === 'folder' || matchesTagFilters(n, this.filters));
      search.set({ results: items.map((node) => ({ node })), loading: false, ran: true, filtered: true, offline: true });
      return;
    }
    try {
      const res = await platform.api.tagSearch(this.filters, this.text.trim() || undefined, { limit: 100 });
      search.set({ results: (res.items || []).map((node) => ({ node })), loading: false, ran: true, filtered: true, offline: false });
    } catch (err) {
      search.set({ loading: false, error: err.message, ran: true, filtered: true });
    }
  }
}

/** Command-palette quick-open: a keyword file search whose results live in the search
 *  service (state.se.paletteFiles) instead of ad-hoc state hung off the UI. */
export class QuickOpenAction extends AppAction {
  constructor(query) {
    super();
    this.query = query;
  }
  async execute({ app }) {
    const { search, platform } = app;
    const q = (this.query || '').trim();
    if (!q) { search.set({ paletteFiles: [] }); return; }
    try {
      const res = await platform.api.search(q, { mode: 'keyword', limit: 30 });
      search.set({ paletteFiles: (res.results || []).filter((r) => r.node.kind === 'file') });
    } catch { search.set({ paletteFiles: [] }); }
  }
}

export class SearchAction extends AppAction {
  constructor(query, mode) {
    super();
    this.query = query;
    this.mode = mode;
  }
  async execute({ app }) {
    const { search, platform } = app;
    const q = this.query.trim();
    if (!q) {
      search.set({ query: '', results: [], ran: false, error: null, resolved: null });
      return;
    }
    const mode = this.mode || platform.settings.get('search.mode');
    search.set({ query: this.query, mode, loading: true, error: null, resolved: null });
    const offline = app.offline;
    // Offline (or server unreachable) → search the pinned corpus locally.
    if (offline && !offline.state.online) {
      try {
        const results = await offline.searchOffline(q, { limit: 40 });
        search.set({ results, loading: false, ran: true, offline: true, resolved: null });
      } catch (err) {
        search.set({ results: [], loading: false, ran: true, offline: true, error: err.message });
      }
      return;
    }
    try {
      // The server transforms the raw query (parse/LLM) and tells us what it actually
      // searched — surfaced to the user via `resolved` so search is honest.
      const res = await platform.api.query(q, { mode, limit: 40 });
      search.set({ results: res.results, resolved: res.resolved || null, loading: false, ran: true, offline: false });
    } catch (err) {
      if (offline) {
        const results = await offline.searchOffline(q, { limit: 40 });
        search.set({ results, loading: false, ran: true, offline: true, error: results.length ? null : err.message });
      } else {
        search.set({ loading: false, error: err.message, ran: true });
      }
    }
  }
}
