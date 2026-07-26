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

/**
 * Load a collection's items. There is nothing to navigate INTO any more — a drive is
 * browsed by search and by following links — so this only ever switches which
 * collection is on screen, or refreshes the current one.
 */
export class NavigateAction extends AppAction {
  constructor(collectionId) {
    super();
    this.collectionId = collectionId;
  }
  async execute({ app }) {
    const { explorer, platform } = app;
    const collectionId = this.collectionId || explorer.state.collectionId || 'default';
    explorer.set({ loading: true, error: null, collectionId });
    try {
      const sort = platform.settings.get('explorer.sort');
      const order = platform.settings.get('explorer.sortOrder');
      const res = await platform.api.list({ sort, order, collection: collectionId });
      explorer.set({
        items: res.items, loading: false, selection: [], sort, order,
        collectionId: res.collectionId || collectionId,
        // What the COLLECTION holds, as against the page we were handed. Reporting the
        // page length would tell someone with 3,000 files that they have 500.
        stats: res.stats || null,
        nextCursor: res.nextCursor || null,
      });
      // Remember where they were, so the next visit opens there rather than guessing.
      platform.settings.set?.('explorer.lastCollection', collectionId);
      // Explorer→context projection (collectionId/hasSelection) lives in bl/index.js
      // so it stays in sync with selection too — nothing to mirror here.
    } catch (err) {
      explorer.set({ loading: false, error: err.message });
      platform.notifications.error(`Couldn't load this collection: ${err.message}`);
    }
  }
}

export class LoadCollectionsAction extends AppAction {
  async execute({ app }) {
    try {
      const res = await app.platform.api.collections();
      const collections = res.collections || [];
      app.explorer.set({ collections, canCreateCollection: !!res.canCreate });
      return collections;
    } catch { /* collections disabled */ return []; }
  }
}

/**
 * Open the drive the user should land on.
 *
 * NOT simply 'default'. On a multi-user deployment plenty of people have no access to
 * the default collection at all, and starting there shows them a permission error
 * instead of their own files — the drive appears broken to the exact users for whom it
 * is working correctly. So: keep the last collection if it is still readable, otherwise
 * take the first one they can actually see.
 */
export class OpenInitialCollectionAction extends AppAction {
  async execute({ app }) {
    // Calls the API directly rather than dispatching LoadCollectionsAction: ngin's
    // dispatch() returns an event feed, not the action's value, so awaiting it would
    // hand back an EventTarget and this would fail in a way nothing reports.
    let collections = [];
    try {
      const res = await app.platform.api.collections();
      collections = res.collections || [];
      app.explorer.set({ collections, canCreateCollection: !!res.canCreate });
    } catch (err) {
      app.explorer.set({ loading: false, error: `Couldn't load your collections: ${err.message}` });
      return;
    }
    const ids = collections.map((c) => c.id);
    const remembered = app.platform.settings.get('explorer.lastCollection');
    if (!ids.length) {
      // A signed-in user with no grants at all. Say so; an empty file list with no
      // explanation reads as "your drive is empty", which is a different and much worse
      // thing to believe.
      app.explorer.set({
        loading: false, items: [], collections: [],
        error: 'You do not have access to any collections yet. Ask an administrator to grant you one.',
      });
      return;
    }
    const target = ids.includes(remembered) ? remembered : (ids.includes('default') ? 'default' : ids[0]);
    return app.engine.dispatch(new NavigateAction(target));
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
      app.engine.dispatch(new NavigateAction(res.collection.id));
    } catch (err) {
      app.platform.notifications.error(`Couldn’t create collection: ${err.message}`);
    }
  }
}

/** Append the next page of a collection to what's already on screen. */
export class LoadMoreAction extends AppAction {
  async execute({ app }) {
    const { explorer, platform } = app;
    const cursor = explorer.state.nextCursor;
    if (!cursor || explorer.state.loadingMore) return;
    explorer.set({ loadingMore: true });
    try {
      const res = await platform.api.list({
        sort: explorer.state.sort, order: explorer.state.order,
        collection: explorer.state.collectionId, cursor,
      });
      explorer.set({
        items: [...explorer.state.items, ...res.items],
        nextCursor: res.nextCursor || null,
        loadingMore: false,
      });
    } catch (err) {
      explorer.set({ loadingMore: false });
      platform.notifications.error(`Couldn't load more: ${err.message}`);
    }
  }
}

export class RefreshAction extends AppAction {
  async execute({ app }) {
    return app.engine.dispatch(new NavigateAction(app.explorer.state.collectionId));
  }
}

export class DeleteAction extends AppAction {
  constructor(ids) {
    super();
    this.ids = ids;
  }
  async execute({ app }) {
    try {
      for (const id of this.ids) await app.platform.api.remove(id);
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
  constructor(files, collectionId) {
    super();
    this.files = files;
    this.collectionId = collectionId;
  }
  async execute({ app }) {
    const collection = this.collectionId || app.explorer.state.collectionId || 'default';
    const concurrency = app.platform.settings.get('uploads.concurrency');
    const uploads = [...this.files].map((file) => this.#one(app, file, collection, concurrency));
    await Promise.allSettled(uploads);
    app.engine.dispatch(new NavigateAction(collection));
  }
  async #one(app, file, collection, concurrency) {
    const { transfers, platform } = app;
    const tid = newId('xfer');
    const controller = new AbortController();
    transfers.start(tid, file.name, file.size, controller);
    let uploadId = null;
    try {
      const node = await platform.api.upload(file, {
        collection, concurrency, signal: controller.signal,
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
      const items = (app.explorer.state.items || []).filter((n) => matchesTagFilters(n, this.filters));
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
    if (!q) { search.set({ paletteFiles: [], paletteQuery: '', paletteError: null, paletteLoading: false }); return; }
    // Keystrokes outrun the network: a slower request for an earlier query must not
    // land on top of a newer one's results. The query itself is the sequence token —
    // whatever the palette input holds now is the only answer worth showing.
    search.set({ paletteQuery: q, paletteLoading: true, paletteError: null });
    try {
      const res = await platform.api.search(q, { mode: 'keyword', limit: 30 });
      if (search.state.paletteQuery !== q) return; // superseded
      search.set({ paletteFiles: res.results || [], paletteLoading: false });
    } catch (err) {
      if (search.state.paletteQuery !== q) return;
      // A failed search must not look like "no files matched" — that reads as a fact
      // about the drive when it's actually a fact about the request.
      search.set({ paletteFiles: [], paletteLoading: false, paletteError: err?.message || 'Search failed' });
    }
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
