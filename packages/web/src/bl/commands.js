// Register the workbench's built-in commands. Commands are the single entry
// point for every action — palette, keybindings, buttons, and menus all call
// `commands.execute(id)`. Handlers here dispatch ngin Actions for anything that
// touches data, and poke the reactive shell services for pure-UI toggles.

import {
  NavigateAction, RefreshAction, CreateFolderAction, DeleteAction, RenameAction,
  UploadFilesAction, OpenFileAction, SearchAction, CreateCollectionAction,
} from './actions.js';

export function registerCommands(app) {
  const { platform, engine, explorer } = app;
  const { commands, workbench } = platform;
  const go = (a) => engine.dispatch(a);

  const cmd = (id, title, handler, extra = {}) => commands.register({ id, title, handler, ...extra });

  // --- navigation / views ----------------------------------------------------
  cmd('workbench.showCommandPalette', 'Show All Commands', () => workbench.openPalette('commands'), { category: 'View', icon: 'command' });
  cmd('workbench.quickOpen', 'Go to File…', () => workbench.openPalette('files'), { category: 'File', icon: 'search' });
  cmd('workbench.view.explorer', 'Show Explorer', () => workbench.setActivity('explorer'), { category: 'View' });
  cmd('workbench.view.search', 'Show Search', () => workbench.setActivity('search'), { category: 'View' });
  cmd('workbench.view.plugins', 'Show Plugins', () => workbench.setActivity('plugins'), { category: 'View' });
  cmd('workbench.openSettings', 'Open Settings', () => workbench.setActivity('settings'), { category: 'Preferences', icon: 'gear' });
  cmd('workbench.toggleSidebar', 'Toggle Sidebar', () => workbench.toggleSidebar(), { category: 'View' });
  cmd('workbench.closeOverlays', 'Close', () => workbench.closeOverlays(), { palette: false });

  // --- explorer --------------------------------------------------------------
  cmd('explorer.refresh', 'Refresh', () => go(new RefreshAction()), { category: 'Explorer', icon: 'refresh' });
  cmd('explorer.up', 'Go Up', () => {
    const trail = explorer.state.breadcrumb;
    const parent = trail[trail.length - 2];
    if (parent) go(new NavigateAction(parent.id));
  }, { category: 'Explorer' });

  cmd('explorer.newFolder', 'New Folder', () => {
    workbench.showDialog({
      kind: 'prompt', title: 'New folder', label: 'Folder name', value: '', placeholder: 'Untitled folder',
      confirmLabel: 'Create',
      onSubmit: (name) => {
        workbench.closeDialog();
        if (name?.trim()) go(new CreateFolderAction(name.trim()));
      },
    });
  }, { category: 'Explorer', icon: 'new-folder' });

  cmd('explorer.upload', 'Upload Files…', () => {
    pickFiles((files) => files.length && go(new UploadFilesAction(files, explorer.state.folder?.id)));
  }, { category: 'Explorer', icon: 'upload' });

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
    if (target?.kind === 'file') triggerDownload(platform.api.downloadUrl(target.id, { attachment: true }), target.name);
  }, { category: 'Explorer', icon: 'download' });

  // --- search ----------------------------------------------------------------
  cmd('search.run', 'Search Files', (q) => go(new SearchAction(q, undefined)), { palette: false });

  // --- offline ---------------------------------------------------------------
  cmd('offline.pin', 'Make Available Offline', (node) => {
    const target = node || explorer.selectedNodes()[0] || workbench.activeTab()?.node;
    if (target?.kind === 'file') app.offline.pin(target);
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
}

// --- helpers ----------------------------------------------------------------

function pickFiles(cb) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    cb(input.files);
    input.remove();
  }, { once: true });
  input.click();
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
