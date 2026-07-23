// ngin Actions — the workbench's business logic as thin, dispatchable verbs
// (CQRS-style). Each depends on the `app` provider (platform + reactive
// services) and performs one user intent: navigate, mutate the tree, upload,
// search, open a file. Errors surface as notifications; the reactive services
// they update flow straight back into the UI via `watch`.

import { Action } from '@3sln/ngin';
import { newId } from '@trove/core/util.js';

class AppAction extends Action {
  static deps = ['app'];
}

export class NavigateAction extends AppAction {
  constructor(target) {
    super();
    this.target = target; // folder id or '/path'
  }
  async execute({ app }) {
    const { explorer, platform } = app;
    explorer.set({ loading: true, error: null });
    try {
      const sort = platform.settings.get('explorer.sort');
      const order = platform.settings.get('explorer.sortOrder');
      const res = await platform.api.list(this.target ?? '/', { sort, order });
      explorer.set({
        folder: res.node, breadcrumb: res.breadcrumb, items: res.items,
        loading: false, selection: [], sort, order,
      });
      platform.context.setMany({ 'explorer.folderId': res.node.id, 'explorer.hasSelection': false });
    } catch (err) {
      explorer.set({ loading: false, error: err.message });
      platform.notifications.error(`Couldn't open folder: ${err.message}`);
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
    await app.platform.api.mkdir(parentId, this.name);
    app.platform.notifications.success(`Created folder "${this.name}"`);
    app.engine.dispatch(new NavigateAction(parentId));
  }
}

export class DeleteAction extends AppAction {
  constructor(ids) {
    super();
    this.ids = ids;
  }
  async execute({ app }) {
    for (const id of this.ids) await app.platform.api.remove(id, true);
    app.platform.notifications.info(`Deleted ${this.ids.length} item${this.ids.length > 1 ? 's' : ''}`);
    for (const id of this.ids) app.platform.workbench.closeTab(id);
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
    const node = await app.platform.api.rename(this.id, this.newName);
    app.platform.workbench.updateTabNode(node.node);
    app.engine.dispatch(new RefreshAction());
  }
}

export class MoveAction extends AppAction {
  constructor(ids, destParentId) {
    super();
    this.ids = ids;
    this.destParentId = destParentId;
  }
  async execute({ app }) {
    for (const id of this.ids) {
      if (id === this.destParentId) continue;
      await app.platform.api.move(id, this.destParentId);
    }
    app.platform.notifications.info(`Moved ${this.ids.length} item${this.ids.length > 1 ? 's' : ''}`);
    app.engine.dispatch(new RefreshAction());
  }
}

export class OpenFileAction extends AppAction {
  constructor(node) {
    super();
    this.node = node;
  }
  async execute({ app }) {
    if (this.node.kind === 'folder') return app.engine.dispatch(new NavigateAction(this.node.id));
    const opener = app.platform.contributions.openerFor(this.node, (w) => app.platform.context.evaluate(w));
    const openerId = opener?.id || 'core.fallback';
    app.platform.workbench.openTab(this.node, openerId);
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
    try {
      await platform.api.upload(file, {
        parentId, concurrency, signal: controller.signal,
        onProgress: (p) => transfers.progress(tid, p),
      });
      transfers.finish(tid, 'done');
    } catch (err) {
      if (err.code === 'aborted') transfers.finish(tid, 'cancelled');
      else {
        transfers.finish(tid, 'error', err.message);
        platform.notifications.error(`Upload failed: ${file.name} — ${err.message}`);
      }
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
      search.set({ query: '', results: [], ran: false, error: null });
      return;
    }
    const mode = this.mode || platform.settings.get('search.mode');
    search.set({ query: this.query, mode, loading: true, error: null });
    try {
      const res = await platform.api.search(q, { mode, limit: 40 });
      search.set({ results: res.results, loading: false, ran: true });
    } catch (err) {
      search.set({ loading: false, error: err.message, ran: true });
    }
  }
}
