// Register the workbench's built-in commands. Commands are the single entry
// point for every action — palette, keybindings, buttons, and menus all call
// `commands.execute(id)`. Handlers here dispatch ngin Actions for anything that
// touches data, and poke the reactive shell services for pure-UI toggles.

import {
  NavigateAction, RefreshAction, DeleteAction, RenameAction,
  UploadFilesAction, OpenFileAction, SearchAction, CreateCollectionAction,
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

  // --- explorer --------------------------------------------------------------
  cmd('explorer.refresh', 'Refresh', () => go(new RefreshAction()), { category: 'Explorer', icon: 'refresh' });
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
        kind: 'confirm', title: `Delete ${nodes.length} item${nodes.length > 1 ? 's' : ''}?`,
        body: nodes.length === 1 ? `"${nodes[0].name}" will be permanently deleted.` : 'These items will be permanently deleted.',
        danger: true, confirmLabel: 'Delete',
        onConfirm: () => {
          workbench.closeDialog();
          doDelete();
        },
      });
    } else doDelete();
  }, { category: 'Explorer', icon: 'trash' });

  cmd('explorer.open', 'Open', (node) => go(new OpenFileAction(node || explorer.selectedNodes()[0])), { palette: false });
  cmd('explorer.download', 'Download', (node) => {
    const target = node || explorer.selectedNodes()[0] || workbench.activeTab()?.node;
    if (target?.id) triggerDownload(platform.api.downloadUrl(target.id, { attachment: true }), target.name);
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
  cmd('collections.switch', 'Switch Collection…', (cid) => { if (cid) go(new NavigateAction('/', cid)); }, { palette: false });
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
  cmd('workbench.toggleInfoPanel', 'Toggle Details & Conversation', () => workbench.toggleInfoPanel(), { category: 'View', icon: 'info' });
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
