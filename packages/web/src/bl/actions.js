// ngin Actions — the workbench's business logic as thin, dispatchable verbs
// (CQRS-style). Each depends on the `app` provider (platform + reactive
// services) and performs one user intent: navigate, mutate the tree, upload,
// search, open a file. Errors surface as notifications; the reactive services
// they update flow straight back into the UI via `watch`.

import { Action } from '@3sln/ngin';
import { newId } from '@3sln/trove/core/util.js';
import { matchesTagFilters } from './tagQuery.js';
import { availableOpeners, rememberedOpenerId } from './openers.js';
// A share link and a `trove:` URI are the same address in two spellings — see core/links.js.
import { parseShareUrl } from '@3sln/trove/core/links.js';

/**
 * Load a collection's items. There is nothing to navigate INTO any more — a drive is
 * browsed by search and by following links — so this only ever switches which
 * collection is on screen, or refreshes the current one.
 */
export class NavigateAction extends Action {
  static deps = ['api', 'explorer', 'notifications', 'settings'];

  constructor(collectionId) {
    super();
    this.collectionId = collectionId;
  }
  async execute(r) {
    const { api, explorer, notifications, settings } = r;
    // No `|| 'default'`. Navigating nowhere in particular used to land on a collection
    // that may not exist and may not be readable; now it is a bug in the caller, said out
    // loud rather than papered over with a guess.
    const collectionId = this.collectionId || explorer.state.collectionId;
    if (!collectionId) {
      explorer.set({ loading: false, gate: 'choose' });
      return;
    }
    const switching = collectionId !== explorer.state.collectionId;
    // A collection's trash belongs to that collection. Carrying it across a switch
    // listed the OLD collection's deleted files under the new one — above an "Empty
    // trash" button that purges the new one, so the rows and the button disagreed
    // about which drive they were talking about.
    explorer.set({ loading: true, error: null, collectionId, ...(switching ? { trash: null } : {}) });
    try {
      const sort = settings.get('explorer.sort');
      const order = settings.get('explorer.sortOrder');
      const res = await api.list(collectionId, { sort, order });
      explorer.set({
        items: res.items, loading: false, selection: [], sort, order,
        collectionId: res.collectionId || collectionId,
        // What the COLLECTION holds, as against the page we were handed. Reporting the
        // page length would tell someone with 3,000 files that they have 500.
        stats: res.stats || null,
        usage: res.usage || null,
        nextCursor: res.nextCursor || null,
      });
      // Remember where they were, so the next visit opens there rather than guessing.
      settings.set?.('explorer.lastCollection', collectionId);
      explorer.set({ gate: null });
      // Explorer→context projection (collectionId/hasSelection) lives in bl/index.js
      // so it stays in sync with selection too — nothing to mirror here.
    } catch (err) {
      explorer.set({ loading: false, error: err.message });
      notifications.error(`Couldn't load this collection: ${err.message}`);
    }
  }
}

export class LoadCollectionsAction extends Action {
  static deps = ['api', 'explorer'];

  async execute(r) {
    try {
      const res = await r.api.collections();
      const collections = res.collections || [];
      r.explorer.set({ collections, canCreateCollection: !!res.canCreate });
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
export class OpenInitialCollectionAction extends Action {
  static deps = ['api', 'engine', 'explorer', 'notifications', 'settings'];

  async execute(r) {
    // A share link decides where we land, ahead of everything below.
    //
    // Arriving at a link to a specific item and being asked which collection you would
    // like to open would be absurd — the link already said. So this runs before the
    // remembered choice and before the gate, and only falls through to them when the URL
    // is not a share link or cannot be honoured.
    const shared = parseShareUrl(typeof location !== 'undefined' ? location.pathname : '');
    if (shared) return this.#openShared(r, shared);

    // Calls the API directly rather than dispatching LoadCollectionsAction: ngin's
    // dispatch() returns an event feed, not the action's value, so awaiting it would
    // hand back an EventTarget and this would fail in a way nothing reports.
    let collections = [];
    let canCreate = false;
    try {
      const res = await r.api.collections();
      collections = res.collections || [];
      canCreate = !!res.canCreate;
      r.explorer.set({ collections, canCreateCollection: canCreate });
    } catch (err) {
      r.explorer.set({ loading: false, error: `Couldn't load your collections: ${err.message}` });
      return;
    }

    const ids = collections.map((c) => c.id);
    const remembered = r.settings.get('explorer.lastCollection');

    // Nothing exists yet. Two different situations that used to read as one:
    if (!ids.length) {
      r.explorer.set({
        loading: false, items: [], collections: [],
        // Someone who may create one is on a fresh drive and should be asked to. Someone
        // who may not has no grants, and telling them to create a collection they cannot
        // create is worse than telling them nothing.
        gate: canCreate ? 'create' : null,
        error: canCreate
          ? null
          : 'You do not have access to any collections yet. Ask an administrator to grant you one.',
      });
      return;
    }

    // There is no fallback to a first or a favourite. Landing somewhere the user did not
    // pick is how the old 'default' behaved, and on a shared drive it opened a collection
    // plenty of people could not read — a permission error presented as their drive.
    // A remembered choice is theirs; anything else is a question.
    if (!remembered || !ids.includes(remembered)) {
      r.explorer.set({ loading: false, items: [], gate: 'choose', error: null });
      return;
    }

    r.explorer.set({ gate: null });
    return r.engine.dispatch(new NavigateAction(remembered));
  }

  /**
   * Open the collection and item a share link names.
   *
   * Every way this can fail says which way it failed. A link to a collection you cannot
   * read, and a link to an item that has been renamed, are different problems with
   * different answers, and both used to be indistinguishable from an empty drive.
   */
  async #openShared(r, shared) {
    const { api, engine, explorer, notifications } = r;
    // The URL is consumed rather than kept. The app does not otherwise reflect its state
    // in the address bar, so leaving a share path there would go stale the moment the user
    // navigated anywhere — a URL that lies is worse than one that is merely uninformative.
    if (typeof history !== 'undefined') history.replaceState(null, '', '/');

    let collections = [];
    try {
      const res = await api.collections();
      collections = res.collections || [];
      explorer.set({ collections, canCreateCollection: !!res.canCreate });
    } catch (err) {
      explorer.set({ loading: false, error: `Couldn’t load your collections: ${err.message}` });
      return;
    }

    if (!collections.some((c) => c.id === shared.collection)) {
      // Said plainly rather than shown as an empty drive. The recipient may simply not
      // have been granted this collection, and that is worth knowing rather than guessing.
      explorer.set({
        loading: false, items: [], gate: null,
        error: `This link points at a collection you do not have access to (“${shared.collection}”). Ask whoever shared it to grant you access.`,
      });
      return;
    }

    explorer.set({ gate: null });
    await engine.dispatch(new NavigateAction(shared.collection));

    let node;
    try {
      // `stat` answers `{ node }` rather than the node — see bl/links.js, which unwraps it
      // the same way. Reading `.id` off the envelope silently looks like "not found".
      const res = shared.by === 'id'
        ? await api.stat(shared.value)
        : await api.stat(shared.value, { collection: shared.collection });
      node = res?.node || null;
    } catch {
      node = null;
    }
    if (!node?.id) {
      // A link by name breaks on rename, deliberately and visibly. Saying so beats
      // landing in the right collection with no explanation of what was expected.
      notifications.warn(
        shared.by === 'name'
          ? `“${shared.value}” is not in this collection any more — it may have been renamed or removed.`
          : 'That item no longer exists.',
      );
      return;
    }
    engine.dispatch(new OpenFileAction(node, { reset: true }));
  }
}

/**
 * Uninstall a plugin.
 *
 * An action rather than a closure threaded through the render tree. Uninstalling is engine
 * work — it is not a render concern in any sense — and it had exactly one call site,
 * reached by carrying a function through fourteen modules of components that had no use
 * for it except to hand it to their children.
 */
/**
 * Run a command.
 *
 * Commands used to be invoked straight on the command service, which meant every command a
 * user ran from the UI — every menu item, every keybinding, every palette entry — went
 * around the engine rather than through it. Nothing could intercept one, nothing could
 * observe one, and the engine's own view of what the app was doing had a hole in it exactly
 * the shape of everything a person actually did.
 *
 * Running one is an action like any other, so it is one.
 *
 * The command's return value is not available here — `dispatch` answers with an event feed
 * rather than the handler's result. That costs nothing today: every one of the call sites
 * is fire-and-forget, and a command that needs to answer its caller wants a query.
 */
export class ExecCommandAction extends Action {
  static deps = ['commands'];
  constructor(id, ...args) {
    super();
    this.id = id;
    this.args = args;
  }
  async execute({ commands }) {
    return commands.execute(this.id, ...this.args);
  }
}

export class UninstallPluginAction extends Action {
  static deps = ['notifications', 'plugins'];

  constructor(pluginId) {
    super();
    this.pluginId = pluginId;
  }
  async execute(r) {
    try {
      await r.plugins.uninstall(this.pluginId);
    } catch (err) {
      r.notifications.error(`Couldn’t uninstall: ${err.message}`);
    }
  }
}

export class CreateCollectionAction extends Action {
  static deps = ['api', 'engine', 'notifications'];

  constructor(record) {
    super();
    this.record = record;
  }
  async execute(r) {
    try {
      const res = await r.api.createCollection(this.record);
      r.notifications.success(`Created collection “${res.collection.name}”`);
      await r.engine.dispatch(new LoadCollectionsAction());
      r.engine.dispatch(new NavigateAction(res.collection.id));
    } catch (err) {
      r.notifications.error(`Couldn’t create collection: ${err.message}`);
    }
  }
}

/** Append the next page of a collection to what's already on screen. */
export class LoadMoreAction extends Action {
  static deps = ['api', 'explorer', 'notifications'];

  async execute(r) {
    const { api, explorer, notifications } = r;
    const cursor = explorer.state.nextCursor;
    if (!cursor || explorer.state.loadingMore) return;
    explorer.set({ loadingMore: true });
    try {
      const res = await api.list(explorer.state.collectionId, {
        sort: explorer.state.sort, order: explorer.state.order, cursor,
      });
      explorer.set({
        items: [...explorer.state.items, ...res.items],
        nextCursor: res.nextCursor || null,
        loadingMore: false,
      });
    } catch (err) {
      explorer.set({ loadingMore: false });
      notifications.error(`Couldn't load more: ${err.message}`);
    }
  }
}

export class RefreshAction extends Action {
  static deps = ['engine', 'explorer'];

  async execute(r) {
    return r.engine.dispatch(new NavigateAction(r.explorer.state.collectionId));
  }
}

/** Show what's been deleted but not destroyed, and act on it. */
export class TrashAction extends Action {
  static deps = ['api', 'engine', 'explorer', 'notifications'];

  constructor(op = 'list', id = null) {
    super();
    this.op = op;
    this.id = id;
  }
  async execute(r) {
    const { api, explorer, notifications } = r;
    const collection = explorer.state.collectionId;
    // Putting it away is one of the things you can do to the trash. Without this the
    // section, once opened, stayed on screen until a page reload — there was no way
    // back to a plain list of files.
    if (this.op === 'hide') {
      explorer.set({ trash: null });
      return;
    }
    try {
      if (this.op === 'restore') {
        const { node } = await api.restore(this.id);
        notifications.success(`Restored “${node.name}”`);
      } else if (this.op === 'purge') {
        await api.purgeTrash({ id: this.id });
      } else if (this.op === 'empty') {
        const { purged } = await api.purgeTrash({ collection });
        notifications.success(`Deleted ${purged} item${purged === 1 ? '' : 's'} for good`);
      }
      const { items } = await api.trash(collection);
      explorer.set({ trash: items });
      // Restoring puts something back in the drive, so the list on screen is now stale.
      if (this.op !== 'list') await r.engine.dispatch(new NavigateAction(collection));
    } catch (err) {
      notifications.error(`Trash: ${err.message}`);
    }
  }
}

export class DeleteAction extends Action {
  static deps = ['api', 'engine', 'notifications', 'workbench'];

  constructor(ids) {
    super();
    this.ids = ids;
  }
  async execute(r) {
    try {
      for (const id of this.ids) await r.api.remove(id);
      r.notifications.info(`Deleted ${this.ids.length} item${this.ids.length > 1 ? 's' : ''}`);
      for (const id of this.ids) r.workbench.closeTab(id);
    } catch (err) {
      r.notifications.error(`Couldn’t delete: ${err.message}`);
    }
    r.engine.dispatch(new RefreshAction());
  }
}

export class RenameAction extends Action {
  static deps = ['api', 'engine', 'notifications', 'workbench'];

  constructor(id, newName) {
    super();
    this.id = id;
    this.newName = newName;
  }
  async execute(r) {
    try {
      const node = await r.api.rename(this.id, this.newName);
      r.workbench.updateTabNode(node.node);
      r.engine.dispatch(new RefreshAction());
    } catch (err) {
      r.notifications.error(`Couldn’t rename: ${err.message}`);
    }
  }
}


export class OpenFileAction extends Action {
  static deps = ['context', 'contributions', 'plugins', 'settings', 'workbench'];

  /** @param {object} node @param {{reset?:boolean}} [opts] reset → start a fresh stack (modal search) */
  constructor(node, opts = {}) {
    super();
    this.node = node;
    this.opts = opts;
  }
  async execute(r) {
    // Guard against being invoked with no target (e.g. a command fired with an empty
    // selection) — dereferencing a null node would throw an unhandled rejection.
    if (!this.node) return;
    const { workbench } = r;
    const open = (openerId) => workbench.openFile(this.node, openerId, { reset: !!this.opts.reset });

    // An explicit opener (e.g. the switch-opener control) wins outright.
    if (this.opts.openerId) return open(this.opts.openerId);

    // Only openers available right now (a plugin previewer needing the network while
    // offline is skipped, so we fall back to a built-in one).
    const avail = availableOpeners(r, this.node);

    // A remembered choice for this file type, if that opener is still available.
    const remembered = rememberedOpenerId(r, this.node);
    if (remembered && avail.some((o) => o.id === remembered)) return open(remembered);

    // Several openers and no saved preference → let the user choose (with an option to
    // remember). One or none → just open the best (or the download fallback).
    if (avail.length > 1) {
      return workbench.showDialog({ kind: 'opener-chooser', node: this.node, openers: avail, reset: !!this.opts.reset });
    }
    open(avail[0]?.id || 'core.fallback');
  }
}

export class UploadFilesAction extends Action {
  static deps = ['api', 'engine', 'explorer', 'notifications', 'settings', 'transfers'];

  constructor(files, collectionId) {
    super();
    this.files = files;
    this.collectionId = collectionId;
  }
  async execute(r) {
    const collection = this.collectionId || r.explorer.state.collectionId;
    // Uploading with no collection open has nowhere to put the bytes. Refused visibly:
    // the old fallback sent them to whatever 'default' happened to be.
    if (!collection) {
      r.notifications.error('Open a collection before uploading');
      return;
    }
    const concurrency = r.settings.get('uploads.concurrency');
    const uploads = [...this.files].map((file) => this.#one(r, file, collection, concurrency));
    await Promise.allSettled(uploads);
    r.engine.dispatch(new NavigateAction(collection));
  }
  /**
   * One file, once — and again, on the same tray row, if the user asks.
   *
   * `existingTid` is what makes a manual retry a second attempt at the row already on
   * screen rather than a new entry beside it. The retry closes over the File, which is why
   * it can run at all without asking the user to find the file again; it is also why the
   * offer does not survive a reload, since nothing here is persisted.
   */
  async #one(r, file, collection, concurrency, existingTid = null) {
    const { api, notifications, transfers } = r;
    const tid = existingTid || newId('xfer');
    const controller = new AbortController();
    if (existingTid) {
      transfers.restart(tid, controller);
    } else {
      transfers.start(tid, file.name, file.size, controller, {
        retry: () => this.#one(r, file, collection, concurrency, tid),
      });
    }
    let uploadId = null;
    try {
      const node = await api.upload(file, {
        collection, concurrency, signal: controller.signal,
        onStart: (id) => { uploadId = id; },
        onProgress: (p) => transfers.progress(tid, p),
      });
      transfers.finish(tid, 'done');
      // The server disambiguates a same-name collision rather than overwriting — tell
      // the user when the saved name differs from what they dropped.
      if (node?.name && node.name !== file.name) {
        notifications.info(`"${file.name}" already existed — saved as "${node.name}".`);
      }
    } catch (err) {
      // Release the server-side session so a cancelled/failed multipart upload doesn't
      // leak an open multipart object (best-effort; the server also sweeps stale ones).
      if (uploadId) api.abortUpload(uploadId).catch(() => {});
      if (err.code === 'aborted') transfers.finish(tid, 'cancelled');
      else {
        transfers.finish(tid, 'error', err.message);
        // The toast says what happened; the tray row is where it can be acted on, and
        // pointing at it is the difference between a dead end and an offer.
        notifications.error(`Upload failed: ${file.name} — ${err.message}. Retry it from the transfers tray.`);
      }
    }
  }
}

/** Drive-wide tag/property filter (`#tag`, `#key:op:value`), optionally narrowed
 *  by free text. Falls back to filtering the loaded folder when offline. */
export class FilterAction extends Action {
  static deps = ['api', 'explorer', 'offline', 'search'];

  constructor(filters, text) {
    super();
    this.filters = filters || [];
    this.text = text || '';
  }
  async execute(r) {
    const { api, search } = r;
    if (!this.filters.length) {
      search.set({ results: [], ran: false, filtered: false });
      return;
    }
    search.set({ query: this.text, loading: true, error: null, filtered: true });
    if (r.offline && !r.offline.state.online) {
      const items = (r.explorer.state.items || []).filter((n) => matchesTagFilters(n, this.filters));
      search.set({ results: items.map((node) => ({ node })), loading: false, ran: true, filtered: true, offline: true });
      return;
    }
    try {
      const res = await api.tagSearch(this.filters, this.text.trim() || undefined, { limit: 100 });
      search.set({ results: (res.items || []).map((node) => ({ node })), loading: false, ran: true, filtered: true, offline: false });
    } catch (err) {
      search.set({ loading: false, error: err.message, ran: true, filtered: true });
    }
  }
}

/** Command-palette quick-open: a keyword file search whose results live in the search
 *  service (state.se.paletteFiles) instead of ad-hoc state hung off the UI. */
export class QuickOpenAction extends Action {
  static deps = ['api', 'search'];

  constructor(query) {
    super();
    this.query = query;
  }
  async execute(r) {
    const { api, search } = r;
    const q = (this.query || '').trim();
    if (!q) { search.set({ paletteFiles: [], paletteQuery: '', paletteError: null, paletteLoading: false }); return; }
    // Keystrokes outrun the network: a slower request for an earlier query must not
    // land on top of a newer one's results. The query itself is the sequence token —
    // whatever the palette input holds now is the only answer worth showing.
    search.set({ paletteQuery: q, paletteLoading: true, paletteError: null });
    try {
      const res = await api.search(q, { mode: 'keyword', limit: 30 });
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

export class SearchAction extends Action {
  static deps = ['api', 'contributions', 'offline', 'search', 'settings'];

  constructor(query, mode) {
    super();
    this.query = query;
    this.mode = mode;
  }
  async execute(r) {
    const { api, contributions, search, settings } = r;
    const q = this.query.trim();
    if (!q) {
      search.set({ query: '', results: [], ran: false, error: null, resolved: null });
      return;
    }
    const mode = this.mode || settings.get('search.mode');
    search.set({ query: this.query, mode, loading: true, error: null, resolved: null });
    const offline = r.offline;
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
      //
      // We send the views we can draw with, because the transformer is the only thing in
      // the stack that read the sentence: "photos from the trip last summer" asks for a
      // gallery, and by the time the results are back all anyone can do is guess from
      // content types. It can only name a view from this list.
      const views = contributions.ofType('view').map((v) => ({ id: v.id, title: v.title || v.id }));
      const res = await api.query(q, { mode, limit: 40, views });
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

// --- API keys (admin) ----------------------------------------------------------

/**
 * Load the key list.
 *
 * Silent on failure rather than noisy: this fires when Settings opens, and a non-admin
 * opening Settings gets a 403 that is the correct answer, not an error worth a toast.
 * The section simply does not render.
 */
export class LoadApiKeysAction extends Action {
  static deps = ['api', 'apiKeys'];

  async execute(r) {
    r.apiKeys.set({ loading: true, error: null });
    try {
      const res = await r.api.apiKeys();
      r.apiKeys.set({ keys: res.keys || [], loading: false, loaded: true, error: null });
    } catch (err) {
      r.apiKeys.set({ loading: false, loaded: true, error: err?.message || 'Could not load API keys' });
    }
  }
}

/**
 * Mint a key and hold the secret for display.
 *
 * The secret is the whole point of the round trip and cannot be fetched again, so it is
 * put into state before anything else can fail. A refresh of the list afterwards is a
 * convenience; losing the secret because the refresh threw would not be.
 */
export class MintApiKeyAction extends Action {
  static deps = ['api', 'apiKeys', 'notifications'];

  constructor(spec) {
    super();
    this.spec = spec;
  }
  async execute(r) {
    r.apiKeys.set({ busy: 'mint', error: null });
    try {
      const { key, secret } = await r.api.mintApiKey(this.spec);
      r.apiKeys.set({ minted: { key, secret }, busy: null });
      const res = await r.api.apiKeys().catch(() => null);
      if (res) r.apiKeys.set({ keys: res.keys || [] });
      return key;
    } catch (err) {
      r.apiKeys.set({ busy: null, error: err?.message || 'Could not create the key' });
      r.notifications.error(err?.message || 'Could not create the key');
      return null;
    }
  }
}

export class RevokeApiKeyAction extends Action {
  static deps = ['api', 'apiKeys', 'notifications'];

  constructor(id) {
    super();
    this.id = id;
  }
  async execute(r) {
    r.apiKeys.set({ busy: this.id, error: null });
    try {
      await r.api.revokeApiKey(this.id);
      const res = await r.api.apiKeys().catch(() => null);
      r.apiKeys.set({ busy: null, ...(res ? { keys: res.keys || [] } : {}) });
      r.notifications.success('Key revoked');
    } catch (err) {
      r.apiKeys.set({ busy: null });
      r.notifications.error(err?.message || 'Could not revoke the key');
    }
  }
}


/**
 * Rebind a keyboard shortcut, or clear it with `key: null`.
 *
 * Carries the binding ID rather than the binding, because a view emits descriptions and an
 * action carries an id — the component that dispatches this has never held the binding
 * object, only a row describing it.
 */
export class RebindKeyAction extends Action {
  static deps = ['keybindings'];
  constructor(bindingId, key) {
    super();
    this.bindingId = bindingId;
    this.key = key;
  }

  async execute({ keybindings: kb }) {
    // `rebind` resolves a binding object or a command id, not a binding id, so look the
    // row back up. Resolving here rather than widening the service keeps the id the only
    // thing that crosses the boundary.
    const binding = kb.resolved().find((b) => b.bindingId === this.bindingId);
    if (!binding) return;
    kb.rebind(binding, this.key);
  }
}

/**
 * Copy text to the clipboard, and say so.
 *
 * Four components had their own version of this, each written slightly differently — two
 * with `.then/.catch`, one with `await` in a `try`, one optional-chaining the clipboard and
 * one not. All four ended the same way, and the ending is the part that matters: a copy that
 * FAILS must still put the text where it can be selected by hand, or the user is left with a
 * button that did nothing and no way to get at what it was for. That is what the sticky
 * fallback is, and it is exactly the sort of detail that rots when it lives in four places.
 *
 * Clipboard access is denied outside a user gesture and in an insecure context, so the
 * failure path is ordinary rather than exceptional.
 */
export class CopyTextAction extends Action {
  static deps = ['notifications'];
  /**
   * @param {string} text
   * @param {string} [label] what the toast says on success
   */
  constructor(text, label = 'Copied') {
    super();
    this.text = text;
    this.label = label;
  }

  async execute({ notifications: notes }) {
    try {
      await navigator.clipboard.writeText(this.text);
      notes.success(this.label);
    } catch {
      notes.info(this.text, { sticky: true });
    }
  }
}

/** Say something to the user. `kind` is one of info, success, warn, error. */
export class NotifyAction extends Action {
  static deps = ['notifications'];
  constructor(kind, message, opts) {
    super();
    this.kind = kind;
    this.message = message;
    this.opts = opts;
  }

  async execute({ notifications: notes }) {
    (notes[this.kind] ?? notes.info).call(notes, this.message, this.opts);
  }
}

/** Dismiss one notification, by id. */
export class DismissNotificationAction extends Action {
  static deps = ['notifications'];
  constructor(id) {
    super();
    this.id = id;
  }

  async execute({ notifications }) {
    notifications.dismiss(this.id);
  }
}

// --- the shell's own surface ----------------------------------------------------
//
// Opening and closing the workbench's overlays. These were direct calls on
// `platform.workbench`, which meant the engine could not see a person close a dialog or
// move through the palette — the same hole `ExecCommandAction` closed for commands.
//
// One class per operation rather than a single ShellAction carrying a method name. The
// point of routing these through the engine is that the feed says what happened; a
// discriminated blob would make every one of them read as "ShellAction" and give back
// exactly the observability this is for.
//
// NOT here yet, deliberately: `showDialog` and `showContextMenu`. Both take callbacks —
// a dialog carries `onConfirm`, a menu carries an item's `run` — so converting them
// mechanically would post a closure through the engine and call it an action. They want
// the outcome to be an ACTION TO DISPATCH rather than a function to call, which is a real
// change at each call site rather than a swap. See docs/tickets/009.

class ShellAction extends Action {
  static deps = ['workbench'];
  async execute({ workbench }) {
    this.apply(workbench);
  }
}

export class CloseDialogAction extends ShellAction {
  apply(wb) { wb.closeDialog(); }
}

export class UpdateDialogAction extends ShellAction {
  constructor(patch) { super(); this.patch = patch; }
  apply(wb) { wb.updateDialog(this.patch); }
}

export class CloseContextMenuAction extends ShellAction {
  apply(wb) { wb.closeContextMenu(); }
}

export class ClosePaletteAction extends ShellAction {
  apply(wb) { wb.closePalette(); }
}

export class SetPaletteQueryAction extends ShellAction {
  constructor(query) { super(); this.query = query; }
  apply(wb) { wb.setPaletteQuery(this.query); }
}

export class SetPaletteIndexAction extends ShellAction {
  constructor(index) { super(); this.index = index; }
  apply(wb) { wb.setPaletteIndex(this.index); }
}

export class MovePaletteAction extends ShellAction {
  constructor(delta) { super(); this.delta = delta; }
  apply(wb) { wb.movePalette(this.delta); }
}

export class CloseSearchModalAction extends ShellAction {
  apply(wb) { wb.closeSearchModal(); }
}

export class SetLaunchQueryAction extends ShellAction {
  constructor(query) { super(); this.query = query; }
  apply(wb) { wb.setLaunchQuery(this.query); }
}

export class SetLaunchIndexAction extends ShellAction {
  constructor(index) { super(); this.index = index; }
  apply(wb) { wb.setLaunchIndex(this.index); }
}

export class OpenSheetAction extends ShellAction {
  constructor(which) { super(); this.which = which; }
  apply(wb) { wb.openSheet(this.which); }
}

export class CloseSheetAction extends ShellAction {
  apply(wb) { wb.closeSheet(); }
}

export class ToggleInfoPanelAction extends ShellAction {
  constructor(open) { super(); this.open = open; }
  apply(wb) { wb.toggleInfoPanel(this.open); }
}

export class OpenPluginPanelAction extends ShellAction {
  constructor(pluginId) { super(); this.pluginId = pluginId; }
  apply(wb) { wb.openPluginPanel(this.pluginId); }
}

export class ClosePluginPanelAction extends ShellAction {
  apply(wb) { wb.closePluginPanel(); }
}

/** Open a node in a panel, with a chosen opener. */
export class OpenInPanelAction extends ShellAction {
  constructor(node, openerId, opts = {}) {
    super();
    this.node = node;
    this.openerId = openerId;
    this.opts = opts;
  }
  apply(wb) { wb.openFile(this.node, this.openerId, this.opts); }
}

// --- the drive's services --------------------------------------------------------
//
// Cancelling a transfer, retrying an issue, tagging a file. These were direct method calls
// on the service, so the engine saw an upload being cancelled only as the state change that
// followed, with nothing to say a person had asked for it.
//
// Named per operation for the same reason the shell actions are: the feed is the point.

class ActivityAction extends Action {
  static deps = ['activity'];
  async execute(r) { this.apply(r.activity); }
}
export class ToggleActivityPanelAction extends ActivityAction {
  constructor(which) { super(); this.which = which; }
  apply(s) { s.togglePanel(this.which); }
}
export class CancelTaskAction extends ActivityAction {
  constructor(id) { super(); this.id = id; }
  apply(s) { s.cancel(this.id); }
}
export class DismissTaskAction extends ActivityAction {
  constructor(id) { super(); this.id = id; }
  apply(s) { s.dismiss(this.id); }
}
export class RetryIssueAction extends ActivityAction {
  constructor(id) { super(); this.id = id; }
  apply(s) { s.retryIssue(this.id); }
}
export class DismissIssueAction extends ActivityAction {
  constructor(id) { super(); this.id = id; }
  apply(s) { s.dismissIssue(this.id); }
}

class TransfersAction extends Action {
  static deps = ['transfers'];
  async execute(r) { this.apply(r.transfers); }
}
export class CancelTransferAction extends TransfersAction {
  constructor(id) { super(); this.id = id; }
  apply(s) { s.cancel(this.id); }
}
export class RetryTransferAction extends TransfersAction {
  constructor(id) { super(); this.id = id; }
  apply(s) { s.retry(this.id); }
}
export class DismissTransferAction extends TransfersAction {
  constructor(id) { super(); this.id = id; }
  apply(s) { s.dismiss(this.id); }
}
export class ClearFinishedTransfersAction extends TransfersAction {
  apply(s) { s.clearDone(); }
}

class SocialAction extends Action {
  static deps = ['social'];
  // Awaited: several of these are network calls, and a dispatch feed that settles before
  // the work does reports success for something still in flight.
  async execute(r) { return this.apply(r.social); }
}
export class ToggleInboxAction extends SocialAction {
  constructor(open) { super(); this.open = open; }
  apply(s) { s.toggleInbox(this.open); }
}

/** Ask the browser for push permission and register. */
export class EnablePushAction extends SocialAction {
  apply(s) { return s.enablePush(); }
}

/** Post a comment on the open item. */
export class PostCommentAction extends SocialAction {
  constructor(body) { super(); this.body = body; }
  apply(s) { return s.comment(this.body); }
}

export class DeleteCommentAction extends SocialAction {
  constructor(commentId) { super(); this.commentId = commentId; }
  apply(s) { return s.deleteComment(this.commentId); }
}

export class ReactToCommentAction extends SocialAction {
  constructor(commentId, emoji) { super(); this.commentId = commentId; this.emoji = emoji; }
  apply(s) { return s.react(this.commentId, this.emoji); }
}

/** Aim the comment box at a comment, or clear it with `null`. */
export class SetReplyToAction extends SocialAction {
  constructor(target) { super(); this.target = target; }
  apply(s) { s.setReplyTo(this.target); }
}
export class AddTagAction extends SocialAction {
  constructor(name, value) { super(); this.name = name; this.value = value; }
  apply(s) { s.addTag(this.name, this.value); }
}
export class RemoveTagAction extends SocialAction {
  constructor(name) { super(); this.name = name; }
  apply(s) { s.removeTag(this.name); }
}
export class LoadSidecarAction extends SocialAction {
  constructor(nodeId) { super(); this.nodeId = nodeId; }
  apply(s) { s.loadSidecar(this.nodeId); }
}

class ApiKeysAction extends Action {
  static deps = ['apiKeys'];
  async execute(r) { this.apply(r.apiKeys); }
}
export class PatchApiKeyDraftAction extends ApiKeysAction {
  constructor(patch) { super(); this.patch = patch; }
  apply(s) { s.patchDraft(this.patch); }
}
export class ToggleApiKeyCapAction extends ApiKeysAction {
  constructor(cap) { super(); this.cap = cap; }
  apply(s) { s.toggleCap(this.cap); }
}

/**
 * Select items in the explorer.
 *
 * `opts` is `{ additive, nodes }`, matching the service — NOT a boolean. It was written as
 * `additive` first, which worked at the one call site only because the options object passed
 * through positionally unchanged. `new SelectItemsAction(ids, true)` would have destructured
 * a boolean into `{additive = false, nodes = null}` and quietly not been additive at all.
 *
 * `nodes` matters when the selection cannot be resolved from the loaded page: the launcher's
 * rows come from search, which is scoped across collections, so the node has to travel with
 * the id.
 */
export class SelectItemsAction extends Action {
  static deps = ['explorer'];

  constructor(ids, opts = {}) { super(); this.ids = ids; this.opts = opts; }

  async execute({ explorer }) {
    const { additive = false, nodes = null } = this.opts;
    const current = explorer.state.selection;
    const next = additive ? Array.from(new Set([...current, ...this.ids])) : this.ids;
    // Selecting what is already selected must not emit. The launcher syncs the highlighted
    // row into here on every mouseenter, and a state push per mouse move would re-render
    // the list under the pointer. The rule lives with the mutation now rather than inside
    // the resource, so the resource only holds and only `set` writes.
    const same = next.length === current.length && next.every((id, i) => id === current[i]);
    if (same) return;
    explorer.set({ selection: next, selectionNodes: nodes && !additive ? nodes : null });
  }
}

/**
 * Move the launcher's highlight and sync the selection to whatever it landed on.
 *
 * ONE action because the two halves are not separable. Moving computes a new index — with
 * wrapping, so it is not `index + delta` — and the selection has to follow the row that
 * index now names. Written as two steps in the component it read the index back out of the
 * store immediately after writing it, which only worked because a direct method call is
 * synchronous. Dispatching is not: the highlight would move and the selection would sync to
 * the previously highlighted row, one keystroke behind, forever, without anything throwing.
 *
 * Here the read-back is inside the action, where it IS sequenced. `nodes` is the results in
 * display order — the component knows the running order, the store only knows the index.
 */
export class MoveLaunchAction extends Action {
  static deps = ['explorer', 'workbench'];
  constructor(delta, nodes) { super(); this.delta = delta; this.nodes = nodes; }
  async execute({ workbench, explorer }) {
    workbench.moveLaunch(this.delta, this.nodes.length);
    selectNode(explorer, this.nodes[workbench.state.launch.index]);
  }
}

/** Highlight a launcher row by position and select it — the pointer/Enter counterpart. */
export class SelectLaunchAction extends Action {
  static deps = ['explorer', 'workbench'];
  constructor(index, node) { super(); this.index = index; this.node = node; }
  async execute({ workbench, explorer }) {
    workbench.setLaunchIndex(this.index);
    selectNode(explorer, this.node);
  }
}

/** Select exactly one node, or nothing. Carries the node itself — see SelectItemsAction. */
function selectNode(explorer, node) {
  const ids = node?.id ? [node.id] : [];
  const current = explorer.state.selection;
  if (ids.length === current.length && ids.every((id, i) => id === current[i])) return;
  explorer.set({ selection: ids, selectionNodes: node ? [node] : null });
}

/**
 * Write one slice of view state — a draft, a capture, a set of ticked boxes.
 *
 * Components used to call the store directly, and two of them did it DURING their own
 * render to install a default. The default is derived now (see `draftFor`), so this only
 * ever runs because a person did something.
 */
export class SetViewStateAction extends Action {
  static deps = ['viewState'];
  constructor(key, value) { super(); this.key = key; this.value = value; }
  async execute({ viewState }) { viewState.set(this.key, this.value); }
}


/**
 * Show a context menu at a point.
 *
 * Only possible now that items carry `actions` rather than `run` closures — this used to be
 * a direct call precisely because dispatching a menu would have meant putting functions on
 * the feed. See ui/activate.js.
 */
export class ShowContextMenuAction extends ShellAction {
  constructor(x, y, items) { super(); this.x = x; this.y = y; this.items = items; }
  apply(wb) { wb.showContextMenu(this.x, this.y, this.items); }
}

/**
 * Show a dialog.
 *
 * A confirm carries `confirmActions` and is fully data. A PROMPT still carries `onSubmit`,
 * because it has to hand back what was typed and the typed value is not in the engine yet —
 * so a prompt posted this way still puts a closure on the feed. Recorded in the ticket
 * rather than pretended away.
 */
export class ShowDialogAction extends ShellAction {
  constructor(dialog) { super(); this.dialog = dialog; }
  apply(wb) { wb.showDialog(this.dialog); }
}

/** Change one setting. */
export class SetSettingAction extends Action {
  static deps = ['settings'];
  constructor(key, value) { super(); this.key = key; this.value = value; }
  async execute({ settings }) { settings.set(this.key, this.value); }
}
