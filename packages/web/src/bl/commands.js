// Register the workbench's built-in commands. Commands are the single entry
// point for every action — palette, keybindings, buttons, and menus all call
// `commands.execute(id)`. Handlers here dispatch ngin Actions for anything that
// touches data, and poke the reactive shell services for pure-UI toggles.

import {
  NavigateAction, RefreshAction, DeleteAction, RenameAction,
  UploadFilesAction, OpenFileAction, SearchAction, CreateCollectionAction, LoadMoreAction, TrashAction,
} from './actions.js';
import { beginInstallFromFile, beginInstallFromUrl } from './pluginInstall.js';
import { troveUri } from '@trove/core/links.js';

export function registerCommands(app) {
  const { platform, engine, explorer } = app;
  const { commands, workbench } = platform;
  const go = (a) => engine.dispatch(a);

  const cmd = (id, title, handler, extra = {}) => commands.register({ id, title, handler, ...extra });

  // --- navigation / views ----------------------------------------------------
  cmd('workbench.showCommandPalette', 'Show All Commands', () => workbench.openPalette('commands'), { category: 'View', icon: 'command' });
  cmd('workbench.quickOpen', 'Go to File…', () => workbench.openPalette('files'), { category: 'File', icon: 'search' });
  cmd('workbench.view.home', 'Go Home (search & browse)', () => workbench.showHome(), { category: 'View', icon: 'search' });
  cmd('workbench.view.plugins', 'Show Plugins', () => workbench.setActivity('plugins'), { category: 'View' });
  cmd('workbench.openSettings', 'Open Settings', () => workbench.setActivity('settings'), { category: 'Preferences', icon: 'gear' });
  cmd('workbench.closeOverlays', 'Close', () => workbench.closeOverlays(), { palette: false });

  // --- background work + standing problems -----------------------------------
  cmd('workbench.showActivity', 'Show Activity (running work & problems)',
    () => app.activity.togglePanel(true), { category: 'View', icon: 'refresh' });
  // The manual scan the drive had no way to ask for. Reports as a task rather than
  // blocking, because on a large drive it takes minutes.
  cmd('workbench.rebuildIndex', 'Rebuild Search Index',
    () => app.activity.rebuildIndex().catch(() => {}), { category: 'View', icon: 'refresh' });
  // Trove is not the only thing that can write to the bucket. This is how files added,
  // replaced, or removed by something else get picked up.
  cmd('workbench.scanCollection', 'Scan Collection for Outside Changes',
    () => app.activity.scanCollection(explorer.state.collectionId || 'default').catch(() => {}),
    { category: 'Explorer', icon: 'refresh' });

  // --- explorer --------------------------------------------------------------
  cmd('explorer.refresh', 'Refresh', () => go(new RefreshAction()), { category: 'Explorer', icon: 'refresh' });
  cmd('explorer.loadMore', 'Show More Items', () => go(new LoadMoreAction()), { palette: false });
  cmd('explorer.upload', 'Upload Files…', () => {
    pickFiles((files) => files.length && go(new UploadFilesAction(files, explorer.state.collectionId)));
  }, { category: 'Explorer', icon: 'upload' });

  // Copy the item's trove: link, which is how one item references another in markdown.
  cmd('explorer.copyLink', 'Copy Link to Item', async () => {
    const node = explorer.selectedNodes()[0] || workbench.activeTab()?.node;
    if (!node) return;
    const uri = troveUri(node);
    try {
      await navigator.clipboard.writeText(uri);
      platform.notifications.success(`Copied ${uri}`);
    } catch {
      // Clipboard access can be denied; showing the link is still useful.
      platform.notifications.info(uri, { sticky: true });
    }
  }, { category: 'Explorer', icon: 'link' });

  cmd('explorer.rename', 'Rename', () => {
    const node = explorer.selectedNodes()[0] || workbench.activeTab()?.node;
    if (!node) return;
    workbench.showDialog({
      kind: 'prompt', title: 'Rename', label: 'New name', value: node.name, confirmLabel: 'Rename',
      onSubmit: (name) => {
        workbench.closeDialog();
        if (name?.trim() && name !== node.name) go(new RenameAction(node.id, name.trim()));
      },
    });
  }, { category: 'Explorer' });

  cmd('explorer.delete', 'Delete', () => {
    const nodes = explorer.selectedNodes();
    if (!nodes.length) return;
    const doDelete = () => go(new DeleteAction(nodes.map((n) => n.id)));
    if (platform.settings.get('explorer.confirmDelete')) {
      workbench.showDialog({
        kind: 'confirm', title: `Move ${nodes.length} item${nodes.length > 1 ? 's' : ''} to the trash?`,
        // Say what actually happens. Telling someone a file will be "permanently
        // deleted" when it goes to the trash trains them to fear a safe action; the
        // reverse — promising recovery that doesn't exist — is worse.
        body: nodes.length === 1
          ? `"${nodes[0].name}" leaves the drive but is kept, and can be restored from the trash.`
          : 'They leave the drive but are kept, and can be restored from the trash.',
        confirmLabel: 'Move to trash',
        onConfirm: () => {
          workbench.closeDialog();
          doDelete();
        },
      });
    } else doDelete();
  }, { category: 'Explorer', icon: 'trash' });

  cmd('explorer.showTrash', 'Show Trash', () => {
    go(new TrashAction('list'));
    workbench.showHome();
  }, { category: 'Explorer', icon: 'trash' });
  cmd('explorer.restore', 'Restore from Trash', (id) => id && go(new TrashAction('restore', id)), { palette: false });
  cmd('explorer.purgeOne', 'Delete Forever', (id) => id && go(new TrashAction('purge', id)), { palette: false });
  cmd('explorer.emptyTrash', 'Empty Trash', () => {
    workbench.showDialog({
      kind: 'confirm', title: 'Empty the trash?',
      body: 'Everything in the trash will be destroyed. This cannot be undone.',
      danger: true, confirmLabel: 'Delete forever',
      onConfirm: () => { workbench.closeDialog(); go(new TrashAction('empty')); },
    });
  }, { category: 'Explorer', icon: 'trash' });

  cmd('explorer.open', 'Open', (node) => go(new OpenFileAction(node || explorer.selectedNodes()[0])), { palette: false });
  cmd('explorer.download', 'Download', async (node) => {
    const target = node || explorer.selectedNodes()[0] || workbench.activeTab()?.node;
    if (!target?.id) return;
    try {
      const { url, revoke } = await platform.api.download(target.id, target.name);
      triggerDownload(url, target.name);
      // A blob URL pins the bytes until it is released; the click has already happened
      // by the time this runs.
      if (revoke) setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      platform.notifications.error(`Couldn't download ${target.name}: ${err.message}`);
    }
  }, { category: 'Explorer', icon: 'download' });

  // --- search ----------------------------------------------------------------
  cmd('search.run', 'Search Files', (q) => go(new SearchAction(q, undefined)), { palette: false });

  // --- offline ---------------------------------------------------------------
  cmd('offline.pin', 'Make Available Offline', (node) => {
    const target = node || explorer.selectedNodes()[0] || workbench.activeTab()?.node;
    if (target?.id) app.offline.pin(target);
  }, { category: 'Offline', icon: 'download' });
  cmd('offline.unpin', 'Remove from Offline', (node) => {
    const target = node || explorer.selectedNodes()[0] || workbench.activeTab()?.node;
    if (target) app.offline.unpin(target.id);
  }, { palette: false });

  // --- collections -----------------------------------------------------------
  // The menu of "where else could I be". Shared by the palette command and the status
  // bar's collection segment, so both offer the same list.
  const collectionMenu = () => {
    const current = explorer.state.collectionId || 'default';
    const items = (explorer.state.collections || []).map((c) => ({
      label: c.name || c.id,
      icon: c.id === current ? 'check' : 'files',
      run: () => commands.execute('collections.switch', c.id),
    }));
    if (explorer.state.canCreateCollection) {
      if (items.length) items.push({ sep: true });
      items.push({ label: 'New collection…', icon: 'plus', run: () => commands.execute('collections.create') });
    }
    return items;
  };
  app.collectionMenu = collectionMenu;

  // `NavigateAction` takes a single collectionId. This passed ('/', cid) — a leftover
  // from a path+collection signature — so every switch navigated to a collection
  // literally named "/" and failed to load. It was also unreachable: no caller, and
  // hidden from the palette.
  cmd('collections.switch', 'Switch Collection…', (cid) => {
    if (cid) {
      go(new NavigateAction(cid));
      workbench.showHome();
      return;
    }
    // From the palette or a keybinding there is no pointer to anchor a menu to.
    const items = collectionMenu();
    if (!items.length) return platform.notifications.info('This drive has one collection.');
    const w = typeof window === 'undefined' ? 800 : window.innerWidth;
    workbench.showContextMenu(Math.max(12, Math.round(w / 2) - 110), 120, items);
  }, { category: 'Collections', icon: 'files' });
  cmd('collections.create', 'New Collection…', () => {
    workbench.showDialog({
      kind: 'collection', title: 'New collection',
      onSubmit: (record) => {
        workbench.closeDialog();
        if (record) go(new CreateCollectionAction(record));
      },
    });
  }, { category: 'Collections', icon: 'files' });

  // --- conversations & notifications -----------------------------------------
  // The details panel is a view OF a file. With nothing open there is nothing for it to
  // show, and flipping the flag silently was indistinguishable from a broken command.
  cmd('workbench.toggleInfoPanel', 'Toggle Details & Conversation', () => {
    if (!workbench.activeTab()) {
      platform.notifications.info('Open a file to see its details and conversation.');
      return;
    }
    workbench.toggleInfoPanel();
  }, { category: 'View', icon: 'info' });
  cmd('notifications.show', 'Show Notifications', () => app.social.toggleInbox(true), { category: 'View' });
  cmd('notifications.enablePush', 'Enable Push Notifications', () => app.social.enablePush(), { category: 'Notifications' });

  // --- plugins ---------------------------------------------------------------
  cmd('plugins.installFromUrl', 'Install Plugin from URL…', () => {
    workbench.showDialog({
      kind: 'prompt', title: 'Install plugin from URL', label: 'Plugin package (.zip) URL',
      placeholder: 'https://example.com/plugin.zip', confirmLabel: 'Fetch',
      onSubmit: (url) => { workbench.closeDialog(); if (url?.trim()) beginInstallFromUrl(app, url.trim()); },
    });
  }, { category: 'Plugins', icon: 'plug' });
  cmd('plugins.installFromFile', 'Install Plugin from File…', () => {
    pickZip((file) => file && beginInstallFromFile(app, file));
  }, { category: 'Plugins', icon: 'plug' });
}

// --- helpers ----------------------------------------------------------------

// Open a native file picker. The hidden <input> is removed on selection AND on
// cancel — cancelling fires no `change`, so we also clean up on the next window
// focus (which the OS dialog returns) to avoid leaking a growing pile of inputs.
function pick(cb, configure) {
  const input = document.createElement('input');
  input.type = 'file';
  configure(input);
  input.style.display = 'none';
  document.body.appendChild(input);
  const cleanup = () => { input.remove(); window.removeEventListener('focus', onFocus); };
  const onFocus = () => setTimeout(() => { if (!input.files.length) cleanup(); }, 300);
  input.addEventListener('change', () => { cb(input.files); cleanup(); }, { once: true });
  window.addEventListener('focus', onFocus);
  input.click();
}
function pickFiles(cb) {
  pick((files) => cb(files), (input) => { input.multiple = true; });
}
function pickZip(cb) {
  pick((files) => cb(files[0]), (input) => { input.accept = '.zip,application/zip'; });
}

function triggerDownload(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name || '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export { pickFiles, triggerDownload };
