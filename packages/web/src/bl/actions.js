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
      const sort = platform.settings.get('explorer.sort');
      const order = platform.settings.get('explorer.sortOrder');
      const res = await platform.api.list(collectionId, { sort, order });
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
      platform.settings.set?.('explorer.lastCollection', collectionId);
      explorer.set({ gate: null });
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
    // A share link decides where we land, ahead of everything below.
    //
    // Arriving at a link to a specific item and being asked which collection you would
    // like to open would be absurd — the link already said. So this runs before the
    // remembered choice and before the gate, and only falls through to them when the URL
    // is not a share link or cannot be honoured.
    const shared = parseShareUrl(typeof location !== 'undefined' ? location.pathname : '');
    if (shared) return this.#openShared(app, shared);

    // Calls the API directly rather than dispatching LoadCollectionsAction: ngin's
    // dispatch() returns an event feed, not the action's value, so awaiting it would
    // hand back an EventTarget and this would fail in a way nothing reports.
    let collections = [];
    let canCreate = false;
    try {
      const res = await app.platform.api.collections();
      collections = res.collections || [];
      canCreate = !!res.canCreate;
      app.explorer.set({ collections, canCreateCollection: canCreate });
    } catch (err) {
      app.explorer.set({ loading: false, error: `Couldn't load your collections: ${err.message}` });
      return;
    }

    const ids = collections.map((c) => c.id);
    const remembered = app.platform.settings.get('explorer.lastCollection');

    // Nothing exists yet. Two different situations that used to read as one:
    if (!ids.length) {
      app.explorer.set({
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
      app.explorer.set({ loading: false, items: [], gate: 'choose', error: null });
      return;
    }

    app.explorer.set({ gate: null });
    return app.engine.dispatch(new NavigateAction(remembered));
  }

  /**
   * Open the collection and item a share link names.
   *
   * Every way this can fail says which way it failed. A link to a collection you cannot
   * read, and a link to an item that has been renamed, are different problems with
   * different answers, and both used to be indistinguishable from an empty drive.
   */
  async #openShared(app, shared) {
    const { platform, explorer, engine } = app;
    // The URL is consumed rather than kept. The app does not otherwise reflect its state
    // in the address bar, so leaving a share path there would go stale the moment the user
    // navigated anywhere — a URL that lies is worse than one that is merely uninformative.
    if (typeof history !== 'undefined') history.replaceState(null, '', '/');

    let collections = [];
    try {
      const res = await platform.api.collections();
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
        ? await platform.api.stat(shared.value)
        : await platform.api.stat(shared.value, { collection: shared.collection });
      node = res?.node || null;
    } catch {
      node = null;
    }
    if (!node?.id) {
      // A link by name breaks on rename, deliberately and visibly. Saying so beats
      // landing in the right collection with no explanation of what was expected.
      platform.notifications.warn(
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
export class ExecCommandAction extends AppAction {
  constructor(id, ...args) {
    super();
    this.id = id;
    this.args = args;
  }
  async execute({ app }) {
    return app.platform.commands.execute(this.id, ...this.args);
  }
}

export class UninstallPluginAction extends AppAction {
  constructor(pluginId) {
    super();
    this.pluginId = pluginId;
  }
  async execute({ app }) {
    try {
      await app.platform.plugins.uninstall(this.pluginId);
    } catch (err) {
      app.platform.notifications.error(`Couldn’t uninstall: ${err.message}`);
    }
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
      const res = await platform.api.list(explorer.state.collectionId, {
        sort: explorer.state.sort, order: explorer.state.order, cursor,
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

/** Show what's been deleted but not destroyed, and act on it. */
export class TrashAction extends AppAction {
  constructor(op = 'list', id = null) {
    super();
    this.op = op;
    this.id = id;
  }
  async execute({ app }) {
    const { explorer, platform } = app;
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
        const { node } = await platform.api.restore(this.id);
        platform.notifications.success(`Restored “${node.name}”`);
      } else if (this.op === 'purge') {
        await platform.api.purgeTrash({ id: this.id });
      } else if (this.op === 'empty') {
        const { purged } = await platform.api.purgeTrash({ collection });
        platform.notifications.success(`Deleted ${purged} item${purged === 1 ? '' : 's'} for good`);
      }
      const { items } = await platform.api.trash(collection);
      explorer.set({ trash: items });
      // Restoring puts something back in the drive, so the list on screen is now stale.
      if (this.op !== 'list') await app.engine.dispatch(new NavigateAction(collection));
    } catch (err) {
      platform.notifications.error(`Trash: ${err.message}`);
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
    const collection = this.collectionId || app.explorer.state.collectionId;
    // Uploading with no collection open has nowhere to put the bytes. Refused visibly:
    // the old fallback sent them to whatever 'default' happened to be.
    if (!collection) {
      app.platform.notifications.error('Open a collection before uploading');
      return;
    }
    const concurrency = app.platform.settings.get('uploads.concurrency');
    const uploads = [...this.files].map((file) => this.#one(app, file, collection, concurrency));
    await Promise.allSettled(uploads);
    app.engine.dispatch(new NavigateAction(collection));
  }
  /**
   * One file, once — and again, on the same tray row, if the user asks.
   *
   * `existingTid` is what makes a manual retry a second attempt at the row already on
   * screen rather than a new entry beside it. The retry closes over the File, which is why
   * it can run at all without asking the user to find the file again; it is also why the
   * offer does not survive a reload, since nothing here is persisted.
   */
  async #one(app, file, collection, concurrency, existingTid = null) {
    const { transfers, platform } = app;
    const tid = existingTid || newId('xfer');
    const controller = new AbortController();
    if (existingTid) {
      transfers.restart(tid, controller);
    } else {
      transfers.start(tid, file.name, file.size, controller, {
        retry: () => this.#one(app, file, collection, concurrency, tid),
      });
    }
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
        // The toast says what happened; the tray row is where it can be acted on, and
        // pointing at it is the difference between a dead end and an offer.
        platform.notifications.error(`Upload failed: ${file.name} — ${err.message}. Retry it from the transfers tray.`);
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
      //
      // We send the views we can draw with, because the transformer is the only thing in
      // the stack that read the sentence: "photos from the trip last summer" asks for a
      // gallery, and by the time the results are back all anyone can do is guess from
      // content types. It can only name a view from this list.
      const views = platform.contributions.ofType('view').map((v) => ({ id: v.id, title: v.title || v.id }));
      const res = await platform.api.query(q, { mode, limit: 40, views });
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
export class LoadApiKeysAction extends AppAction {
  async execute({ app }) {
    app.apiKeys.set({ loading: true, error: null });
    try {
      const res = await app.platform.api.apiKeys();
      app.apiKeys.set({ keys: res.keys || [], loading: false, loaded: true, error: null });
    } catch (err) {
      app.apiKeys.set({ loading: false, loaded: true, error: err?.message || 'Could not load API keys' });
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
export class MintApiKeyAction extends AppAction {
  constructor(spec) {
    super();
    this.spec = spec;
  }
  async execute({ app }) {
    app.apiKeys.set({ busy: 'mint', error: null });
    try {
      const { key, secret } = await app.platform.api.mintApiKey(this.spec);
      app.apiKeys.set({ minted: { key, secret }, busy: null });
      const res = await app.platform.api.apiKeys().catch(() => null);
      if (res) app.apiKeys.set({ keys: res.keys || [] });
      return key;
    } catch (err) {
      app.apiKeys.set({ busy: null, error: err?.message || 'Could not create the key' });
      app.platform.notifications.error(err?.message || 'Could not create the key');
      return null;
    }
  }
}

export class RevokeApiKeyAction extends AppAction {
  constructor(id) {
    super();
    this.id = id;
  }
  async execute({ app }) {
    app.apiKeys.set({ busy: this.id, error: null });
    try {
      await app.platform.api.revokeApiKey(this.id);
      const res = await app.platform.api.apiKeys().catch(() => null);
      app.apiKeys.set({ busy: null, ...(res ? { keys: res.keys || [] } : {}) });
      app.platform.notifications.success('Key revoked');
    } catch (err) {
      app.apiKeys.set({ busy: null });
      app.platform.notifications.error(err?.message || 'Could not revoke the key');
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
export class RebindKeyAction extends AppAction {
  constructor(bindingId, key) {
    super();
    this.bindingId = bindingId;
    this.key = key;
  }

  async execute({ app }) {
    const kb = app.platform.keybindings;
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
export class CopyTextAction extends AppAction {
  /**
   * @param {string} text
   * @param {string} [label] what the toast says on success
   */
  constructor(text, label = 'Copied') {
    super();
    this.text = text;
    this.label = label;
  }

  async execute({ app }) {
    const notes = app.platform.notifications;
    try {
      await navigator.clipboard.writeText(this.text);
      notes.success(this.label);
    } catch {
      notes.info(this.text, { sticky: true });
    }
  }
}

/** Say something to the user. `kind` is one of info, success, warn, error. */
export class NotifyAction extends AppAction {
  constructor(kind, message, opts) {
    super();
    this.kind = kind;
    this.message = message;
    this.opts = opts;
  }

  async execute({ app }) {
    const notes = app.platform.notifications;
    (notes[this.kind] ?? notes.info).call(notes, this.message, this.opts);
  }
}

/** Dismiss one notification, by id. */
export class DismissNotificationAction extends AppAction {
  constructor(id) {
    super();
    this.id = id;
  }

  async execute({ app }) {
    app.platform.notifications.dismiss(this.id);
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

class ShellAction extends AppAction {
  async execute({ app }) {
    this.apply(app.platform.workbench);
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

class ActivityAction extends AppAction {
  async execute({ app }) { this.apply(app.activity); }
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

class TransfersAction extends AppAction {
  async execute({ app }) { this.apply(app.transfers); }
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

class SocialAction extends AppAction {
  async execute({ app }) { this.apply(app.social); }
}
export class ToggleInboxAction extends SocialAction {
  apply(s) { s.toggleInbox(); }
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

class ApiKeysAction extends AppAction {
  async execute({ app }) { this.apply(app.apiKeys); }
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
export class SelectItemsAction extends AppAction {
  constructor(ids, opts = {}) { super(); this.ids = ids; this.opts = opts; }
  async execute({ app }) { app.explorer.select(this.ids, this.opts); }
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
export class MoveLaunchAction extends AppAction {
  constructor(delta, nodes) { super(); this.delta = delta; this.nodes = nodes; }
  async execute({ app }) {
    const wb = app.platform.workbench;
    wb.moveLaunch(this.delta, this.nodes.length);
    selectNode(app, this.nodes[wb.state.launch.index]);
  }
}

/** Highlight a launcher row by position and select it — the pointer/Enter counterpart. */
export class SelectLaunchAction extends AppAction {
  constructor(index, node) { super(); this.index = index; this.node = node; }
  async execute({ app }) {
    app.platform.workbench.setLaunchIndex(this.index);
    selectNode(app, this.node);
  }
}

/** Select exactly one node, or nothing. Carries the node itself — see SelectItemsAction. */
function selectNode(app, node) {
  app.explorer.select(node?.id ? [node.id] : [], { nodes: node ? [node] : null });
}
