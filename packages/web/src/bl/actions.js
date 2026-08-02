// ngin Actions — the workbench's business logic as thin, dispatchable verbs
// (CQRS-style). Each depends on the `app` provider (platform + reactive
// services) and performs one user intent: navigate, mutate the tree, upload,
// search, open a file. Errors surface as notifications; the reactive services
// they update flow straight back into the UI via `watch`.

import { Action } from '@3sln/ngin';
import { runAction } from '../dispatch.js';
import { PROMPT } from './viewState.js';
import { beginInstallFromUrl } from './pluginInstall.js';
import { newId } from '@3sln/trove/core/util.js';
import { matchesTagFilters } from './tagQuery.js';
import { availableOpeners, rememberedOpenerId, withAssociation, ASSOC_KEY } from './openers.js';
// A share link and a `trove:` URI are the same address in two spellings — see core/links.js.
import { parseShareUrl, troveUri, shareUrl } from '@3sln/trove/core/links.js';
import { selectedNodesOf, draftScopesOf, collectionMenuOf } from './services.js';
import { beginInstallFromFile } from './pluginInstall.js';
import { pickFiles, pickZip, triggerDownload } from '../platform/pickers.js';
import { wrapIndex } from './state.js';

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
    const collectionId = this.collectionId || explorer.get().collectionId;
    if (!collectionId) {
      explorer.set({ loading: false, gate: 'choose' });
      return;
    }
    const switching = collectionId !== explorer.get().collectionId;
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
      settings.set('explorer.lastCollection', collectionId);
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
    // Sequenced, so the panel this opens below lands on top of the collection rather than
    // racing its load — see src/dispatch.js for why a bare `await` here did nothing.
    await runAction(engine, new NavigateAction(shared.collection));

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
      // Sequenced: `NavigateAction` writes `collectionId` synchronously while the load
      // writes `collections` after a round trip, so navigating first left the status bar's
      // `collectionLabelOf` with nothing to look the id up in — it showed a raw `col_…`.
      await runAction(r.engine, new LoadCollectionsAction());
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
    const cursor = explorer.get().nextCursor;
    if (!cursor || explorer.get().loadingMore) return;
    explorer.set({ loadingMore: true });
    try {
      const res = await api.list(explorer.get().collectionId, {
        sort: explorer.get().sort, order: explorer.get().order, cursor,
      });
      explorer.set({
        items: [...explorer.get().items, ...res.items],
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
    return r.engine.dispatch(new NavigateAction(r.explorer.get().collectionId));
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
    const collection = explorer.get().collectionId;
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
      if (this.op !== 'list') r.engine.dispatch(new NavigateAction(collection));
    } catch (err) {
      notifications.error(`Trash: ${err.message}`);
    }
  }
}

export class DeleteAction extends Action {
  // `navigation`, not `workbench`: the panel stack and the recents list are both its, and a
  // deleted file must not survive in either.
  static deps = ['api', 'engine', 'navigation', 'notifications'];

  constructor(ids) {
    super();
    this.ids = ids;
  }
  async execute(r) {
    try {
      for (const id of this.ids) await r.api.remove(id);
      r.notifications.info(`Deleted ${this.ids.length} item${this.ids.length > 1 ? 's' : ''}`);
      for (const id of this.ids) r.navigation.forget(id);
    } catch (err) {
      r.notifications.error(`Couldn’t delete: ${err.message}`);
    }
    r.engine.dispatch(new RefreshAction());
  }
}

export class RenameAction extends Action {
  // The renamed node has to reach the open panel too, or the title bar keeps the old name
  // until something else refreshes it. That stack belongs to `navigation`.
  static deps = ['api', 'engine', 'navigation', 'notifications'];

  constructor(id, newName) {
    super();
    this.id = id;
    this.newName = newName;
  }
  async execute(r) {
    try {
      const node = await r.api.rename(this.id, this.newName);
      r.navigation.updateTabNode(node.node);
      r.engine.dispatch(new RefreshAction());
    } catch (err) {
      r.notifications.error(`Couldn’t rename: ${err.message}`);
    }
  }
}


export class OpenFileAction extends Action {
  static deps = ['context', 'contributions', 'engine', 'plugins', 'settings'];

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
    const open = (openerId) => r.engine.dispatch(new OpenInPanelAction(this.node, openerId, { reset: !!this.opts.reset }));

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
      return r.engine.dispatch(new ShowDialogAction({ kind: 'opener-chooser', node: this.node, openers: avail, reset: !!this.opts.reset }));
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
    const collection = this.collectionId || r.explorer.get().collectionId;
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
      const items = (r.explorer.get().items || []).filter((n) => matchesTagFilters(n, this.filters));
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
  static deps = ['api', 'overlay', 'search'];

  constructor(query) {
    super();
    this.query = query;
  }
  async execute(r) {
    const { api, overlay, search } = r;
    // The palette's mode as it is NOW, not as it was when the keystroke's timer was set.
    // This guard used to live in the debounce callback in the component, which had to read
    // it back off the service for exactly this reason — a listener belongs to the render
    // that created it, and the mode can change under a pending timer.
    if (overlay.get().palette?.mode !== 'files') return;
    const q = (this.query || '').trim();
    if (!q) { search.set({ paletteFiles: [], paletteQuery: '', paletteError: null, paletteLoading: false }); return; }
    // Keystrokes outrun the network: a slower request for an earlier query must not
    // land on top of a newer one's results. The query itself is the sequence token —
    // whatever the palette input holds now is the only answer worth showing.
    search.set({ paletteQuery: q, paletteLoading: true, paletteError: null });
    try {
      const res = await api.search(q, { mode: 'keyword', limit: 30 });
      if (search.get().paletteQuery !== q) return; // superseded
      search.set({ paletteFiles: res.results || [], paletteLoading: false });
    } catch (err) {
      if (search.get().paletteQuery !== q) return;
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

/**
 * The overlays: palette, dialog, context menu, plugin panel.
 *
 * Their own lease. Closing a dialog used to go through the workbench facade and therefore
 * leased the entire shell — the panel stack, the launcher cursor and the sheet included —
 * to set one field to null.
 */
class OverlayAction extends Action {
  static deps = ['overlay'];
  async execute({ overlay }) {
    this.apply(overlay);
  }
}

/** The panel stack. Still a service: it mirrors into browser history and persists recents. */
class NavAction extends Action {
  static deps = ['navigation'];
  async execute({ navigation }) {
    this.apply(navigation);
  }
}

export class CloseDialogAction extends OverlayAction {
  apply(o) { o.set({ dialog: null }); }
}

/** Merge a patch into the open dialog — a reactive dialog, like the opener chooser. */
export class UpdateDialogAction extends OverlayAction {
  constructor(patch) { super(); this.patch = patch; }
  apply(o) {
    const dialog = o.get().dialog;
    if (dialog) o.set({ dialog: { ...dialog, ...this.patch } });
  }
}

export class CloseContextMenuAction extends OverlayAction {
  apply(o) { o.set({ contextMenu: null }); }
}

export class ClosePaletteAction extends OverlayAction {
  apply(o) { o.set({ palette: null }); }
}

export class SetPaletteQueryAction extends OverlayAction {
  constructor(query) { super(); this.query = query; }
  apply(o) {
    const palette = o.get().palette;
    // Back to the top: the previous highlight belonged to the previous result set.
    if (palette) o.set({ palette: { ...palette, query: this.query, index: 0 } });
  }
}

export class SetPaletteIndexAction extends OverlayAction {
  constructor(index) { super(); this.index = index; }
  apply(o) {
    const palette = o.get().palette;
    if (palette) o.set({ palette: { ...palette, index: this.index } });
  }
}

/**
 * Move the palette's highlight, wrapping at either end.
 *
 * The wrapping is HERE now. It used to be in the service with this action forwarding two
 * arguments to it — and it forwarded one, so the service could not tell where the end was,
 * returned early, and the arrow keys did nothing at all. Deciding and writing in one place
 * is what removes the chance.
 */
export class MovePaletteAction extends OverlayAction {
  constructor(delta, count) { super(); this.delta = delta; this.count = count; }
  apply(o) {
    const palette = o.get().palette;
    if (!palette || !this.count) return;
    o.set({ palette: { ...palette, index: wrapIndex(palette.index, this.delta, this.count) } });
  }
}

/** The double-shift overlay: a search that starts empty and resets the stack on a pick. */
export class OpenSearchModalAction extends ShellAction {
  apply(wb) { wb.set({ searchModal: true, launch: { query: '', index: 0 } }); }
}

export class CloseSearchModalAction extends ShellAction {
  apply(wb) { wb.set({ searchModal: false }); }
}

/** Open (or close) one collection's access list on the administration screen. */
export class ShowCollectionAccessAction extends ShellAction {
  constructor(collectionId) { super(); this.collectionId = collectionId; }
  apply(wb) { wb.set({ aclFor: wb.get().aclFor === this.collectionId ? null : this.collectionId }); }
}

export class SetLaunchQueryAction extends ShellAction {
  constructor(query) { super(); this.query = query; }
  // Back to the top, for the same reason the palette does: the old highlight belonged to
  // the old results.
  apply(wb) { wb.set({ launch: { query: this.query, index: 0 } }); }
}

export class SetLaunchIndexAction extends ShellAction {
  constructor(index) { super(); this.index = index; }
  apply(wb) { wb.set({ launch: { ...wb.get().launch, index: this.index } }); }
}

/** Raise, swap, or drop the phone bottom sheet. Tapping the open one closes it. */
export class OpenSheetAction extends ShellAction {
  constructor(which) { super(); this.which = which; }
  apply(wb) { wb.set({ sheet: wb.get().sheet === this.which ? null : this.which }); }
}

export class CloseSheetAction extends ShellAction {
  apply(wb) { wb.set({ sheet: null }); }
}

export class ToggleInfoPanelAction extends ShellAction {
  constructor(open) { super(); this.open = open; }
  apply(wb) { wb.set({ infoPanel: this.open ?? !wb.get().infoPanel }); }
}

export class OpenPluginPanelAction extends OverlayAction {
  constructor(pluginId) { super(); this.pluginId = pluginId; }
  apply(o) { o.set({ pluginPanel: this.pluginId }); }
}

export class ClosePluginPanelAction extends OverlayAction {
  apply(o) { o.set({ pluginPanel: null }); }
}

/**
 * Open a node in a panel, with a chosen opener.
 *
 * Three things at once, and they belong together: the panel goes on the stack, the shell
 * switches to the drive, and the modal search — if that is where the pick came from —
 * closes behind it. The workbench service used to do the coordinating because the stack
 * lives in one place and the activity in another; an action is a better home for "these
 * happen together" than a facade over both.
 */
export class OpenInPanelAction extends Action {
  static deps = ['navigation', 'workbench'];
  constructor(node, openerId, opts = {}) {
    super();
    this.node = node;
    this.openerId = openerId;
    this.opts = opts;
  }
  async execute({ navigation, workbench }) {
    workbench.set({ activity: 'home', searchModal: false });
    navigation.openFile(this.node, this.openerId, this.opts);
  }
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

/** Change one field of the mint form. Does nothing when there is no form open. */
export class PatchApiKeyDraftAction extends ApiKeysAction {
  constructor(patch) { super(); this.patch = patch; }
  apply(s) {
    const draft = s.get().draft;
    if (draft) s.set({ draft: { ...draft, ...this.patch } });
  }
}

/**
 * Toggle one capability on one collection in the draft.
 *
 * Per COLLECTION and capability: a key is scoped, so a capability without the collection
 * it applies to is meaningless. This used to be arithmetic inside the service with an
 * action in front of it forwarding two arguments — and it forwarded one, so the collection
 * id arrived as the capability and the server refused every mint. Deciding and writing are
 * one step now, with nothing in between to drop.
 *
 * `admin` is not treated specially. It is offered as itself and the server expands it;
 * pre-ticking read/write/delete alongside it would suggest they are separable afterwards,
 * and they are not.
 */
export class ToggleApiKeyCapAction extends ApiKeysAction {
  constructor(collectionId, capability) { super(); this.collectionId = collectionId; this.capability = capability; }
  apply(s) {
    const draft = s.get().draft;
    if (!draft) return;
    const caps = { ...draft.caps };
    const held = new Set(caps[this.collectionId] || []);
    if (held.has(this.capability)) held.delete(this.capability);
    else held.add(this.capability);
    if (held.size) caps[this.collectionId] = [...held];
    else delete caps[this.collectionId];
    s.set({ draft: { ...draft, caps } });
  }
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
    const current = explorer.get().selection;
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
    const count = this.nodes.length;
    if (!count) return;
    const index = wrapIndex(workbench.get().launch.index, this.delta, count);
    workbench.set({ launch: { ...workbench.get().launch, index } });
    selectNode(explorer, this.nodes[index]);
  }
}

/** Highlight a launcher row by position and select it — the pointer/Enter counterpart. */
export class SelectLaunchAction extends Action {
  static deps = ['explorer', 'workbench'];
  constructor(index, node) { super(); this.index = index; this.node = node; }
  async execute({ workbench, explorer }) {
    workbench.set({ launch: { ...workbench.get().launch, index: this.index } });
    selectNode(explorer, this.node);
  }
}

/** Select exactly one node, or nothing. Carries the node itself — see SelectItemsAction. */
function selectNode(explorer, node) {
  const ids = node?.id ? [node.id] : [];
  const current = explorer.get().selection;
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
  async execute({ viewState }) { viewState.set({ [this.key]: this.value }); }
}


/**
 * Show a context menu at a point.
 *
 * Only possible now that items carry `actions` rather than `run` closures — this used to be
 * a direct call precisely because dispatching a menu would have meant putting functions on
 * the feed. See ui/activate.js.
 */
export class ShowContextMenuAction extends OverlayAction {
  constructor(x, y, items) { super(); this.x = x; this.y = y; this.items = items; }
  apply(o) { o.set({ contextMenu: { x: this.x, y: this.y, items: this.items } }); }
}

/**
 * Show a dialog.
 *
 * The spec is data. A confirm carries `confirmActions`; so does a prompt, whose actions read
 * what was typed out of view state rather than being handed it — see PromptAction. Nothing
 * in a dialog spec is callable, which matters because the spec lives in workbench state.
 */
export class ShowDialogAction extends OverlayAction {
  constructor(dialog) { super(); this.dialog = dialog; }
  apply(o) { o.set({ dialog: this.dialog }); }
}

/** Change one setting. */
export class SetSettingAction extends Action {
  static deps = ['settings'];
  constructor(key, value) { super(); this.key = key; this.value = value; }
  async execute({ settings }) { settings.set(this.key, this.value); }
}

/**
 * Remember which opener a file type should use, or forget it with a null openerId.
 *
 * Not `SetSettingAction` with a pre-merged map, because building that map means reading the
 * current one — and a component that reads settings to compute what to write is the same
 * stale-base race as the drafts had (see PatchDraftAction). The merge happens here, against
 * what is stored.
 */
export class RememberOpenerAction extends Action {
  static deps = ['settings'];
  constructor(typeKey, openerId) { super(); this.typeKey = typeKey; this.openerId = openerId; }
  async execute({ settings }) {
    if (!this.typeKey) return;
    settings.set(ASSOC_KEY, withAssociation(settings.get(ASSOC_KEY), this.typeKey, this.openerId));
  }
}

/** Back through the panel stack. */
export class NavigateBackAction extends NavAction {
  apply(nav) { nav.back(); }
}

/** Close the viewer stack and return to the drive. */
export class ShowHomeAction extends Action {
  static deps = ['navigation', 'workbench'];
  async execute({ navigation, workbench }) {
    workbench.set({ activity: 'home', searchModal: false });
    navigation.reset();
  }
}

/** Reload one plugin — re-read its manifest and restart its worker. */
export class RefreshPluginAction extends Action {
  static deps = ['plugins'];
  constructor(pluginId) { super(); this.pluginId = pluginId; }
  async execute({ plugins }) { return plugins.refresh(this.pluginId); }
}

/**
 * Store a plugin secret.
 *
 * Not a setting: secrets go somewhere settings do not, which is why this is its own action
 * rather than SetSettingAction with a different key.
 */
export class SetPluginSecretAction extends Action {
  static deps = ['plugins'];
  constructor(pluginId, key, value) { super(); this.pluginId = pluginId; this.key = key; this.value = value; }
  async execute({ plugins }) { return plugins.setSecret(this.pluginId, this.key, this.value); }
}

/**
 * Open whatever a notification points at.
 *
 * The stat, the open, the panel and the failure message are one action because they are one
 * intent. Spread across a component they were a `.then` chain that had to know the API
 * answers `{ node }` rather than a node, and had to remember that a notification can
 * outlive its target — the item may be deleted, or live somewhere the reader has since
 * lost access to. Either way the click must say so rather than do nothing.
 */
export class OpenNotificationTargetAction extends Action {
  // Five of these used to exist only to feed a hand-call of `OpenFileAction.execute(r)` —
  // the one `.execute(` in the package — and one of them, `explorer`, fed nothing at all.
  // The coupling was invisible: a dep added to OpenFileAction broke THIS action at runtime
  // with an `undefined`, the same failure mode as the missing `overlay` above. Dispatching
  // instead also puts the open on the feed, which it never was: opening from a notification
  // and opening from a row click are the same intent and the engine should see both.
  static deps = ['api', 'engine', 'notifications', 'workbench'];

  constructor(nodeId) { super(); this.nodeId = nodeId; }

  async execute({ api, engine, notifications, workbench }) {
    let node;
    try {
      ({ node } = await api.stat(this.nodeId));
    } catch (err) {
      notifications.warn(err?.status === 403 || err?.code === 'forbidden'
        ? 'You no longer have access to that item.'
        : 'That item no longer exists.');
      return;
    }
    // `.next([...])`, because `dispatch` returns a feed and the panel must open AFTER the
    // file does — see platform/commands.js, which names this trap.
    await runAction(engine, new OpenFileAction(node));
    workbench.set({ infoPanel: true });
  }
}

/**
 * The base for anything a prompt dialog submits.
 *
 * The typed value is engine state (see viewState.js), so the action READS it rather than
 * being handed it by a callback. Subclasses implement `withValue`; the dialog closes first,
 * because every one of these used to do that by hand and two forgot to do it consistently.
 */
export class PromptAction extends Action {
  static deps = ['overlay', 'viewState'];

  async execute(r) {
    const held = r.viewState.get()[PROMPT];
    const value = (held?.value ?? '').trim();
    r.overlay.set({ dialog: null });
    if (value) await this.withValue(value, r);
  }
}

/** Rename the node this prompt was opened for. */
export class RenamePromptAction extends PromptAction {
  static deps = ['engine', 'overlay', 'viewState'];
  constructor(node) { super(); this.node = node; }
  async withValue(name, { engine }) {
    if (name !== this.node.name) engine.dispatch(new RenameAction(this.node.id, name));
  }
}

/** Fetch and review a plugin package from the URL that was typed. */
export class InstallPluginFromUrlPromptAction extends PromptAction {
  static deps = ['notifications', 'overlay', 'plugins', 'social', 'viewState', 'workbench'];
  async withValue(url, r) { await beginInstallFromUrl(r, url); }
}

/**
 * Create the collection the dialog's form describes.
 *
 * The form is already engine state — the dialog puts it in viewState as it is typed — so
 * this reads it rather than being handed a record through a callback. The form-to-record
 * shaping stays in the dialog, which is the thing that knows which fields the chosen
 * driver declared.
 */
export class CreateCollectionFromFormAction extends Action {
  static deps = ['engine', 'overlay'];
  constructor(record) { super(); this.record = record; }
  async execute({ engine, overlay }) {
    overlay.set({ dialog: null });
    if (this.record) engine.dispatch(new CreateCollectionAction(this.record));
  }
}

/**
 * Change one field of a draft, merging against what is stored RATHER than against what the
 * render saw.
 *
 * Every field handler used to build `{ ...form, [k]: value }` from the `form` its own render
 * closed over. Two changes to different fields before the next render therefore both merged
 * onto the same stale base, and the second silently dropped the first — type a name, switch
 * the storage driver in the same frame, and the name is gone with the Create button quietly
 * disabled. Renders are coalesced by rAF, so "in the same frame" is not rare, and a
 * backgrounded tab makes it certain.
 *
 * Reading current state inside the action removes the window entirely.
 *
 * @param {string} key       which draft
 * @param {object} ref       the dialog instance it belongs to
 * @param {object} patch     the field(s) being changed
 * @param {object} fallback  the draft's default, for when the held one is another dialog's
 */
export class PatchDraftAction extends Action {
  static deps = ['viewState'];

  constructor(key, ref, patch, fallback = {}) {
    super();
    this.key = key;
    this.ref = ref;
    this.patch = patch;
    this.fallback = fallback;
  }

  async execute({ viewState }) {
    const held = viewState.get()[this.key];
    const base = held && held.ref === this.ref ? held.form : this.fallback;
    viewState.set({ [this.key]: { ref: this.ref, form: { ...base, ...this.patch } } });
  }
}

// --- what commands used to do inline ---------------------------------------------
//
// bl/commands.js registered 40 commands and 36 of them were CLOSURES over `app` — the whole
// world — doing effects outside the engine. That mattered more than the line count suggests,
// because commands are the entry point for everything a person actually does: the palette,
// every keybinding, every menu item, every row button. `ExecCommandAction` routed the intent
// in and the handler walked straight back out, so the engine saw a command being run and
// then nothing of what it did.
//
// A command is a DESCRIPTION now — `{ id, title, actions(...args) }`, where `actions` is a
// pure factory. Everything below is where those handler bodies went.

/**
 * The file a command acts on: the one it was handed, else the selection, else what is open.
 *
 * Three commands resolved this identically and a fourth got it slightly wrong. "Nothing is
 * selected" is a real answer and has to be said out loud — returning silently is
 * indistinguishable from a broken command.
 */
function subjectOf({ explorer, navigation, notifications }, node = null) {
  const found = node || selectedNodesOf(explorer.get())[0] || navigation.activeTab()?.node;
  if (!found) notifications.info('Pick a file first — highlight one in the list, or open it.');
  return found;
}

/** Open the command palette, or quick-open, depending on the mode. */
export class OpenPaletteAction extends OverlayAction {
  constructor(mode = 'commands', query = '') { super(); this.mode = mode; this.query = query; }
  apply(o) { o.set({ palette: { mode: this.mode, query: this.query, index: 0 } }); }
}

/** Switch the main area between the drive, plugins and settings. */
export class SetActivityAction extends ShellAction {
  constructor(activity) { super(); this.activity = activity; }
  apply(wb) { wb.set({ activity: this.activity, sidebarVisible: true }); }
}

/**
 * Close the topmost transient thing — what Escape does.
 *
 * The ORDER is the whole content of this action, and it spans four resources: the menu
 * over the dialog, the dialog over the phone sheet, the sheet over the modal search, and
 * only when none of those is up does Escape start popping the panel stack. Getting it wrong
 * is not a crash — it is Escape closing the wrong thing, which is why it is written out
 * once, here, rather than distributed over whoever owns each overlay.
 */
export class CloseOverlaysAction extends Action {
  static deps = ['activity', 'navigation', 'overlay', 'workbench'];
  async execute({ activity, navigation, overlay, workbench }) {
    const o = overlay.get();
    const wb = workbench.get();
    if (o.contextMenu) return overlay.set({ contextMenu: null });
    if (o.dialog) return overlay.set({ dialog: null });
    if (wb.sheet) return workbench.set({ sheet: null });
    if (wb.searchModal) return workbench.set({ searchModal: false });
    if (o.palette) return overlay.set({ palette: null });
    if (o.pluginPanel) return overlay.set({ pluginPanel: null });
    // The activity panel floats over the page and carries a close button like everything
    // else in this ladder, and was the one such surface Escape did not reach. Below the
    // plugin panel deliberately: it opens BY ITSELF when a storage check finishes, and
    // Escape should not close what you opened on purpose in order to dismiss what
    // appeared on its own.
    if (activity.state?.open) return activity.togglePanel(false);
    // Nothing floating: Escape pops the top viewer panel instead.
    if (navigation.state.stack.length > 1) navigation.back();
  }
}

/**
 * Speak to search.
 *
 * On a TV this is mostly NOT about recognising anything: a remote's mic dictates into
 * whatever text field the platform keyboard is attached to, and is swallowed by the system
 * assistant when there isn't one. So the first job is to put the search field on screen and
 * focused, which is a feature on every TV whether or not the browser can transcribe. Where
 * it can — on-device only, see platform/voice.js — it also starts listening and types what
 * it hears.
 */
export class VoiceSearchAction extends Action {
  static deps = ['engine', 'voice'];
  async execute({ engine, voice }) {
    await voice.run({
      onText: (text, { final }) => {
        if (!text) return;
        engine.dispatch(new SetLaunchQueryAction(text));
        // Interim results keep the box in step with the speaker; only the settled
        // transcript is worth a round trip to the server.
        if (final) engine.dispatch(new SearchAction(text));
      },
    });
  }
}

/** Reindex the whole drive. Reports as a task rather than blocking — it takes minutes. */
export class RebuildIndexAction extends Action {
  static deps = ['activity'];
  async execute({ activity }) { return activity.rebuildIndex().catch(() => {}); }
}

/**
 * Pick up files added, replaced or removed in the bucket by something other than Trove.
 *
 * No collection means no scan. This used to fall back to one called 'default', which on a
 * drive that has none scanned a collection that does not exist and reported the failure as
 * a scan error.
 */
export class ScanCollectionAction extends Action {
  static deps = ['activity', 'explorer', 'notifications'];
  async execute({ activity, explorer, notifications }) {
    const id = explorer.get().collectionId;
    if (!id) return notifications.info('Open a collection first — a scan is per collection.');
    return activity.scanCollection(id).catch(() => {});
  }
}

/**
 * Whether the backing stores are reachable from a browser at all.
 *
 * Separate from a scan: a scan asks what the store HOLDS, this asks whether it can be READ
 * from here — the failure that makes every file open to a spinner.
 */
export class CheckStorageAction extends Action {
  static deps = ['activity'];
  async execute({ activity }) { return activity.checkStorage().catch(() => {}); }
}

/** Ask for files, then upload them into the open collection. */
export class PickAndUploadAction extends Action {
  static deps = ['engine', 'explorer'];
  async execute({ engine, explorer }) {
    const collection = explorer.get().collectionId;
    // Awaited, so the feed's `complete` means the upload started rather than the dialog
    // opened — and so the leases below it are still held when the upload uses them.
    const files = await pickFiles();
    if (files?.length) await runAction(engine, new UploadFilesAction(files, collection));
  }
}

/**
 * Copy a link to the subject, in one of its two spellings.
 *
 * `trove:` is what one document writes to link another; it means nothing to a browser. A
 * share link is a URL you can paste into a message. Both end at CopyTextAction, which is
 * the thing that knows a failed copy must still leave the text somewhere selectable.
 */
export class CopyLinkAction extends Action {
  static deps = ['engine', 'explorer', 'navigation', 'notifications'];
  /** @param {'trove'|'share'} kind */
  constructor(kind = 'trove', node = null) { super(); this.kind = kind; this.node = node; }
  async execute(r) {
    const node = subjectOf(r, this.node);
    if (!node) return;
    return r.engine.dispatch(this.kind === 'share'
      ? new CopyTextAction(shareUrl(node, location.origin),
        'Link copied — anyone with access to this collection can open it')
      : new CopyTextAction(troveUri(node), `Copied ${troveUri(node)}`));
  }
}

/** Ask for a new name for the subject. The prompt's value is read by RenamePromptAction. */
export class RenameSubjectAction extends Action {
  static deps = ['engine', 'explorer', 'navigation', 'notifications'];
  constructor(node = null) { super(); this.node = node; }
  async execute(r) {
    const node = subjectOf(r, this.node);
    if (!node) return;
    r.engine.dispatch(new ShowDialogAction({
      kind: 'prompt', title: 'Rename', label: 'New name', value: node.name, confirmLabel: 'Rename',
      confirmActions: [new RenamePromptAction(node)],
    }));
  }
}

/**
 * Move the selection to the trash, confirming first unless that was turned off.
 *
 * Deleting the file you have OPEN is the obvious intent when nothing is selected, so it
 * counts as the subject. The confirmation says what actually happens: telling someone a
 * file will be "permanently deleted" when it goes to the trash trains them to fear a safe
 * action, and the reverse — promising recovery that doesn't exist — is worse.
 */
export class DeleteSubjectAction extends Action {
  static deps = ['engine', 'explorer', 'navigation', 'notifications', 'settings'];
  async execute(r) {
    const nodes = selectedNodesOf(r.explorer.get());
    const open = nodes.length ? null : r.navigation.activeTab()?.node;
    if (open) nodes.push(open);
    if (!nodes.length) {
      r.notifications.info('Pick a file first — highlight one in the list, or open it.');
      return;
    }
    const deleteThem = new DeleteAction(nodes.map((n) => n.id));
    if (!r.settings.get('explorer.confirmDelete')) return r.engine.dispatch(deleteThem);
    r.engine.dispatch(new ShowDialogAction({
      kind: 'confirm',
      title: `Move ${nodes.length} item${nodes.length > 1 ? 's' : ''} to the trash?`,
      body: nodes.length === 1
        ? `"${nodes[0].name}" leaves the drive but is kept, and can be restored from the trash.`
        : 'They leave the drive but are kept, and can be restored from the trash.',
      confirmLabel: 'Move to trash',
      confirmActions: [deleteThem],
    }));
  }
}

/** Show the trash, and get back to the drive to see it. */
export class ShowTrashAction extends Action {
  static deps = ['engine'];
  async execute({ engine }) {
    engine.dispatch(new TrashAction('list'));
    engine.dispatch(new ShowHomeAction());
  }
}

/** Open the subject in a viewer. */
export class OpenSubjectAction extends Action {
  static deps = ['engine', 'explorer', 'navigation', 'notifications'];
  constructor(node = null) { super(); this.node = node; }
  async execute(r) {
    const node = subjectOf(r, this.node);
    if (node) return r.engine.dispatch(new OpenFileAction(node));
  }
}

/** Save the subject to the machine. */
export class DownloadSubjectAction extends Action {
  static deps = ['api', 'explorer', 'navigation', 'notifications'];
  constructor(node = null) { super(); this.node = node; }
  async execute(r) {
    const target = subjectOf(r, this.node);
    if (!target?.id) return;
    try {
      const { url, revoke } = await r.api.download(target.id, target.name);
      triggerDownload(url, target.name);
      // A blob URL pins the bytes until it is released; the click has already happened by
      // the time this runs.
      if (revoke) setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      r.notifications.error(`Couldn't download ${target.name}: ${err.message}`);
    }
  }
}

/** Keep a copy of the subject for offline use, or stop keeping one. */
export class PinAction extends Action {
  static deps = ['explorer', 'navigation', 'notifications', 'offline'];
  constructor(node = null, pinned = true) { super(); this.node = node; this.pinned = pinned; }
  async execute(r) {
    const target = subjectOf(r, this.node);
    if (!target?.id) return;
    return this.pinned ? r.offline.pin(target) : r.offline.unpin(target.id);
  }
}

// --- API keys (admin) ------------------------------------------------------------

class ApiKeyDraftAction extends Action {
  static deps = ['apiKeys'];
  async execute({ apiKeys }) { this.apply(apiKeys); }
}
export class StartApiKeyDraftAction extends ApiKeyDraftAction {
  apply(s) { s.set({ draft: { name: '', expiresInDays: '', caps: {} }, error: null }); }
}
export class CancelApiKeyDraftAction extends ApiKeyDraftAction {
  apply(s) { s.set({ draft: null }); }
}
/** Forget the freshly minted secret. On dismiss, and after a copy. */
export class ClearMintedApiKeyAction extends ApiKeyDraftAction {
  apply(s) { if (s.get().minted) s.set({ minted: null }); }
}

/**
 * Mint the key the draft describes.
 *
 * The days-to-instant conversion is here rather than in the form because the server compares
 * against its own clock: "30 days from whenever this arrives" is not what was chosen. The
 * draft is cleared BEFORE the mint so the form cannot be submitted twice while it is in
 * flight.
 */
export class MintApiKeyFromDraftAction extends Action {
  static deps = ['apiKeys', 'engine'];
  async execute({ apiKeys, engine }) {
    const draft = apiKeys.get().draft;
    const scopes = draftScopesOf(apiKeys.get());
    if (!draft?.name?.trim() || !scopes) return;
    const days = Number(draft.expiresInDays);
    const expiresAt = draft.expiresInDays !== '' && Number.isFinite(days) && days > 0
      ? Date.now() + days * 86400_000
      : null;
    apiKeys.set({ draft: null });
    return engine.dispatch(new MintApiKeyAction({ name: draft.name.trim(), scopes, expiresAt }));
  }
}

// --- collections -----------------------------------------------------------------

/**
 * Switch to a collection, or offer the choice when none was named.
 *
 * From the palette or a keybinding there is no pointer to anchor a menu to, so it opens
 * centred near the top.
 */
export class SwitchCollectionAction extends Action {
  static deps = ['engine', 'explorer', 'notifications'];
  constructor(collectionId = null) { super(); this.collectionId = collectionId; }
  async execute({ engine, explorer, notifications }) {
    if (this.collectionId) {
      engine.dispatch(new NavigateAction(this.collectionId));
      engine.dispatch(new ShowHomeAction());
      return;
    }
    const items = collectionMenuOf(explorer.get(),
      (id) => new ExecCommandAction('collections.switch', id),
      () => new ExecCommandAction('collections.create'));
    if (!items.length) return notifications.info('This drive has one collection.');
    const w = typeof window === 'undefined' ? 800 : window.innerWidth;
    engine.dispatch(new ShowContextMenuAction(Math.max(12, Math.round(w / 2) - 110), 120, items));
  }
}

/**
 * Show the details panel — but only when there is a file for it to be about.
 *
 * With nothing open there is nothing to show, and flipping the flag silently was
 * indistinguishable from a broken command.
 */
export class ToggleDetailsAction extends Action {
  static deps = ['navigation', 'notifications', 'workbench'];
  async execute({ navigation, notifications, workbench }) {
    if (!navigation.activeTab()) {
      notifications.info('Open a file to see its details and conversation.');
      return;
    }
    workbench.set({ infoPanel: !workbench.get().infoPanel });
  }
}

// --- plugins ---------------------------------------------------------------------

/** Ask for a .zip and take it through the install review. */
export class PickAndInstallPluginAction extends Action {
  static deps = ['notifications', 'overlay', 'plugins', 'social', 'workbench'];
  async execute(r) {
    const file = await pickZip();
    if (file) await beginInstallFromFile(r, file);
  }
}

/**
 * Run a command a PLUGIN registered.
 *
 * Plugin commands used to be handlers proxying straight over RPC, which left the same hole
 * for them that `ExecCommandAction` closed for the host's own: the engine could see a plugin
 * command being invoked only as whatever state changed afterwards. Now every command in the
 * registry — host or plugin — resolves to actions.
 */
export class InvokePluginCommandAction extends Action {
  static deps = ['plugins'];
  constructor(pluginId, name, args = []) {
    super();
    this.pluginId = pluginId;
    this.name = name;
    this.args = args;
  }
  async execute({ plugins }) {
    return plugins.invokeCommand(this.pluginId, this.name, this.args);
  }
}

/**
 * Forget the open item's conversation — but only if it is still the one named.
 *
 * Dispatched when the last observer of a `sidecarFor` query goes away. Scoped to the node
 * because kill and boot are not ordered against each other: switching from A to B can kill
 * A's query after B's has booted, and an unscoped clear would wipe what B just loaded.
 */
export class ClearSidecarAction extends Action {
  static deps = ['social'];
  constructor(nodeId) { super(); this.nodeId = nodeId; }
  async execute({ social }) {
    if (social.state.sidecar?.nodeId === this.nodeId) social.loadSidecar(null);
  }
}

// --- key rotation ---------------------------------------------------------------
//
// Rotation moves a collection onto a fresh key, object by object, bounded by wall-clock
// time per slice. It runs on the server; what the UI needs is to see where it is, what it
// would cost before anyone starts, and a way to stop it.

/**
 * Read where the rotation stands, and what one would cost.
 *
 * The estimate comes with the state rather than only before starting: on a metered store
 * this is a real bill, and the number is worth having in front of the button.
 */
/**
 * Read one collection's access list.
 *
 * Takes the collection rather than reading the open one, because this is asked from a
 * screen that lists every collection — the rotation equivalent next door can assume the
 * open one and this cannot.
 */
export class LoadGrantsAction extends Action {
  static deps = ['acl', 'api', 'notifications'];
  constructor(collectionId) { super(); this.collectionId = collectionId; }
  async execute({ acl, api, notifications }) {
    const collectionId = this.collectionId;
    if (!collectionId) return;
    acl.set({ collectionId, loading: true, error: null });
    try {
      const res = await api.collectionGrants(collectionId);
      acl.set({ grants: res?.grants || [], admins: res?.admins || [], loading: false });
    } catch (err) {
      // A non-admin gets a 403, and that is the correct answer rather than an error worth
      // a toast — the section simply does not offer itself. Same reasoning as the rotation
      // loader immediately below.
      acl.set({ loading: false, error: err?.message || 'Could not read the access list' });
      if (err?.status !== 403) notifications.error?.(err?.message || 'Could not read the access list');
    }
  }
}

/**
 * Grant or revoke, which are one operation.
 *
 * An empty capability list removes the grant — that is `setGrant`'s existing shape, and
 * keeping it means revoking cannot drift from granting. Reloads afterwards rather than
 * patching the slice, because the server expands capabilities (admin implies the rest) and
 * a client that guessed the expansion would eventually disagree with it.
 */
export class SetGrantAction extends Action {
  static deps = ['acl', 'api', 'engine', 'notifications'];
  constructor(collectionId, grant) { super(); this.collectionId = collectionId; this.grant = grant; }
  async execute({ acl, api, engine, notifications }) {
    acl.set({ busy: true });
    try {
      await api.setCollectionGrant(this.collectionId, this.grant);
      const who = this.grant.type === 'anyone' ? 'everyone' : this.grant.subject;
      notifications.success?.(this.grant.capabilities?.length
        ? `Access for ${who} updated`
        : `Access for ${who} removed`);
    } catch (err) {
      notifications.error?.(err?.message || 'Could not change access');
    } finally {
      acl.set({ busy: false });
      await runAction(engine, new LoadGrantsAction(this.collectionId));
    }
  }
}

export class LoadRotationAction extends Action {
  static deps = ['api', 'explorer', 'notifications', 'rotation'];
  async execute({ api, explorer, notifications, rotation }) {
    const collectionId = explorer.get().collectionId;
    if (!collectionId) return;
    rotation.set({ collectionId, loading: true, error: null });
    try {
      // Both together: the estimate is meaningless without knowing whether one is already
      // running, and a screen showing one without the other invites starting a second.
      const [state, estimate] = await Promise.all([
        api.rotationState(collectionId),
        api.rotationEstimate(collectionId).catch(() => null),
      ]);
      rotation.set({ rotation: state?.rotation ?? null, estimate: estimate ?? null, loading: false });
    } catch (err) {
      // A non-admin gets a 403 here and that is the correct answer, not an error worth a
      // toast — the section simply does not render.
      rotation.set({ loading: false, error: err?.message || 'Could not read the rotation state' });
      if (err?.status !== 403) notifications.error?.(err?.message || 'Could not read the rotation state');
    }
  }
}

/** Start moving this collection onto a new key. */
export class BeginRotationAction extends Action {
  static deps = ['api', 'engine', 'explorer', 'notifications', 'rotation'];
  async execute({ api, engine, explorer, notifications, rotation }) {
    const collectionId = explorer.get().collectionId;
    if (!collectionId) return;
    rotation.set({ busy: true });
    try {
      const res = await api.beginRotation(collectionId);
      rotation.set({ rotation: res?.rotation ?? null, busy: false });
      // The new key becomes current immediately, before any file moves — so the
      // fingerprint on screen is already out of date. Reload the collections or it keeps
      // showing the key the collection is moving OFF, which is the one thing this field
      // exists to get right.
      engine.dispatch(new LoadCollectionsAction());
      notifications.info('Key rotation started. It runs in the background and survives a reload.');
    } catch (err) {
      rotation.set({ busy: false });
      notifications.error(err?.message || 'Could not start the rotation');
    }
    return engine.dispatch(new LoadRotationAction());
  }
}

/**
 * Stop one.
 *
 * What has already moved stays moved and the new key stays current, so this is untidy
 * rather than destructive — worth saying, because "cancel" on a job that has rewritten
 * half a collection sounds like it might undo something.
 */
export class CancelRotationAction extends Action {
  static deps = ['api', 'engine', 'explorer', 'notifications', 'rotation'];
  async execute({ api, engine, explorer, notifications, rotation }) {
    const collectionId = explorer.get().collectionId;
    if (!collectionId) return;
    rotation.set({ busy: true });
    try {
      await api.cancelRotation(collectionId);
      notifications.info('Rotation stopped. Files already moved stay on the new key.');
    } catch (err) {
      notifications.error(err?.message || 'Could not stop the rotation');
    }
    rotation.set({ busy: false });
    return engine.dispatch(new LoadRotationAction());
  }
}
