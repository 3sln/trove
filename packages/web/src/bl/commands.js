// The workbench's built-in commands.
//
// A command is a DESCRIPTION: an id, a title, and `actions(...args)` — a pure factory
// saying what should be dispatched. It does not do anything itself.
//
// That is the whole change here, and it matters more than it looks. Commands are the entry
// point for everything a person actually does: the palette, every keybinding, every menu
// item, every row button. These were closures over `app` — the whole world — calling
// services directly, so `ExecCommandAction` routed the intent into the engine and the
// handler walked straight back out. The engine saw a command being run and nothing of what
// it did: no feed entry for the delete, the upload, or the collection switch, and nothing
// able to intercept or observe one.
//
// The bodies moved into actions (bl/actions.js, "what commands used to do inline"). What is
// left is a table, which is what a command registry should have been.
//
// `palette: false` where a command is a button on a screen rather than a verb someone would
// go looking for. Revoking a credential by fuzzy-searching for it is not a thing to make
// easy.

import {
  NavigateAction, RefreshAction, LoadMoreAction, TrashAction, ShowTrashAction,
  UploadFilesAction, PickAndUploadAction, OpenSubjectAction, DownloadSubjectAction,
  CopyLinkAction, RenameSubjectAction, DeleteSubjectAction, PinAction,
  SearchAction, VoiceSearchAction,
  RebuildIndexAction, ScanCollectionAction, CheckStorageAction, ToggleActivityPanelAction,
  LoadApiKeysAction, RevokeApiKeyAction, MintApiKeyFromDraftAction,
  StartApiKeyDraftAction, CancelApiKeyDraftAction, ClearMintedApiKeyAction,
  OpenPaletteAction, SetActivityAction, CloseOverlaysAction, ShowHomeAction,
  ShowDialogAction, SwitchCollectionAction, ToggleDetailsAction,
  ToggleInboxAction, EnablePushAction,
  InstallPluginFromUrlPromptAction, PickAndInstallPluginAction,
} from './actions.js';

// Everything that acts on "the file you mean" — the selection, or the one you have open.
//
// Without this the palette offered Rename and Delete on an empty drive, accepted the click,
// and answered with "Pick a file first". A when-clause greys them instead, which is the
// difference between an offer the drive cannot honour and an accurate menu.
//
// Row menus satisfy it because opening one SELECTS the row first (see openRowMenu), so a
// command reached that way always has a subject even though the clause cannot see the node
// argument it was handed.
const HAS_SUBJECT = 'explorer.hasSelection || editor.open';

export function registerCommands(app) {
  const cmd = (id, title, actions, extra = {}) =>
    app.platform.commands.register({ id, title, actions, ...extra });

  // --- navigation / views ----------------------------------------------------
  cmd('workbench.showCommandPalette', 'Show All Commands', () => new OpenPaletteAction('commands'), { category: 'View', icon: 'command' });
  cmd('workbench.quickOpen', 'Go to File…', () => new OpenPaletteAction('files'), { category: 'File', icon: 'search' });
  cmd('workbench.view.home', 'Go Home (search & browse)', () => new ShowHomeAction(), { category: 'View', icon: 'search' });
  cmd('workbench.view.plugins', 'Show Plugins', () => new SetActivityAction('plugins'), { category: 'View' });
  cmd('workbench.view.admin', 'Show Administration', () => new SetActivityAction('admin'), { category: 'View', icon: 'gear' });
  cmd('workbench.openSettings', 'Open Settings', () => new SetActivityAction('settings'), { category: 'Preferences', icon: 'gear' });
  cmd('workbench.closeOverlays', 'Close', () => new CloseOverlaysAction(), { palette: false });
  cmd('search.voice', 'Search by Voice', () => new VoiceSearchAction(), { category: 'View', icon: 'search' });

  // --- background work + standing problems -----------------------------------
  cmd('workbench.showActivity', 'Show Activity (running work & problems)',
    () => new ToggleActivityPanelAction(true), { category: 'View', icon: 'refresh' });
  cmd('workbench.rebuildIndex', 'Rebuild Search Index',
    () => new RebuildIndexAction(), { category: 'View', icon: 'refresh' });
  // Trove is not the only thing that can write to the bucket. This is how files added,
  // replaced, or removed by something else get picked up.
  cmd('workbench.scanCollection', 'Scan Collection for Outside Changes',
    () => new ScanCollectionAction(), { category: 'Explorer', icon: 'refresh' });
  cmd('workbench.checkStorage', 'Check Storage Configuration',
    () => new CheckStorageAction(), { category: 'View', icon: 'plug' });

  // --- explorer --------------------------------------------------------------
  cmd('explorer.refresh', 'Refresh', () => new RefreshAction(), { category: 'Explorer', icon: 'refresh' });
  cmd('explorer.loadMore', 'Show More Items', () => new LoadMoreAction(), { palette: false });
  cmd('explorer.upload', 'Upload Files…', () => new PickAndUploadAction(), { category: 'Explorer', icon: 'upload' });
  // Two spellings of one address, and which you want depends on where it is going.
  // `trove:` is what one document writes to link another; a share link is a URL you can
  // paste into a message. Offered under both names, labelled for the destination rather
  // than for the format, which is the difference between a choice and a riddle.
  cmd('explorer.copyShareLink', 'Copy Shareable Link', (node) => new CopyLinkAction('share', node), { category: 'Explorer', icon: 'link', when: HAS_SUBJECT });
  cmd('explorer.copyLink', 'Copy Link to Item', (node) => new CopyLinkAction('trove', node), { category: 'Explorer', icon: 'link', when: HAS_SUBJECT });
  cmd('explorer.rename', 'Rename', (node) => new RenameSubjectAction(node), { category: 'Explorer', when: HAS_SUBJECT });
  cmd('explorer.delete', 'Delete', () => new DeleteSubjectAction(), { category: 'Explorer', icon: 'trash', when: HAS_SUBJECT });
  cmd('explorer.open', 'Open', (node) => new OpenSubjectAction(node), { palette: false });
  cmd('explorer.download', 'Download', (node) => new DownloadSubjectAction(node), { category: 'Explorer', icon: 'download', when: HAS_SUBJECT });

  // --- trash -----------------------------------------------------------------
  cmd('explorer.showTrash', 'Show Trash', () => new ShowTrashAction(), { category: 'Explorer', icon: 'trash' });
  cmd('explorer.hideTrash', 'Hide Trash', () => new TrashAction('hide'), { palette: false });
  cmd('explorer.restore', 'Restore from Trash', (id) => (id ? new TrashAction('restore', id) : null), { palette: false });
  cmd('explorer.purgeOne', 'Delete Forever', (id) => (id ? new TrashAction('purge', id) : null), { palette: false });
  // Wholly declarative: the confirmation is data, and what it confirms is an action.
  cmd('explorer.emptyTrash', 'Empty Trash', () => new ShowDialogAction({
    kind: 'confirm', title: 'Empty the trash?',
    body: 'Everything in the trash will be destroyed. This cannot be undone.',
    danger: true, confirmLabel: 'Delete forever',
    confirmActions: [new TrashAction('empty')],
  }), { category: 'Explorer', icon: 'trash' });

  // --- API keys (admin) ---------------------------------------------------------
  cmd('keys.load', 'Load API Keys', () => new LoadApiKeysAction(), { palette: false });
  cmd('keys.new', 'New API Key', () => new StartApiKeyDraftAction(), { palette: false });
  cmd('keys.cancel', 'Cancel API Key', () => new CancelApiKeyDraftAction(), { palette: false });
  cmd('keys.dismissMinted', 'Dismiss API Key', () => new ClearMintedApiKeyAction(), { palette: false });
  cmd('keys.revoke', 'Revoke API Key', (id) => (id ? new RevokeApiKeyAction(id) : null), { palette: false });
  cmd('keys.mint', 'Create API Key', () => new MintApiKeyFromDraftAction(), { palette: false });

  // --- offline ---------------------------------------------------------------
  cmd('offline.pin', 'Make Available Offline', (node) => new PinAction(node, true), { category: 'Offline', icon: 'download', when: HAS_SUBJECT });
  cmd('offline.unpin', 'Remove from Offline', (node) => new PinAction(node, false), { palette: false });

  // --- collections -----------------------------------------------------------
  cmd('collections.switch', 'Switch Collection…', (cid) => new SwitchCollectionAction(cid), { category: 'Collections', icon: 'files' });
  cmd('collections.create', 'New Collection…', () => new ShowDialogAction({ kind: 'collection', title: 'New collection' }), { category: 'Collections', icon: 'files' });

  // --- conversations & notifications -----------------------------------------
  cmd('workbench.toggleInfoPanel', 'Toggle Details & Conversation', () => new ToggleDetailsAction(), { category: 'View', icon: 'info' });
  cmd('notifications.show', 'Show Notifications', () => new ToggleInboxAction(true), { category: 'View' });
  cmd('notifications.enablePush', 'Enable Push Notifications', () => new EnablePushAction(), { category: 'Notifications' });

  // --- plugins ---------------------------------------------------------------
  cmd('plugins.installFromUrl', 'Install Plugin from URL…', () => new ShowDialogAction({
    kind: 'prompt', title: 'Install plugin from URL', label: 'Plugin package (.zip) URL',
    placeholder: 'https://example.com/plugin.zip', confirmLabel: 'Fetch',
    confirmActions: [new InstallPluginFromUrlPromptAction()],
  }), { category: 'Plugins', icon: 'plug' });
  cmd('plugins.installFromFile', 'Install Plugin from File…', () => new PickAndInstallPluginAction(), { category: 'Plugins', icon: 'plug' });
}

// Kept for the one caller that still hands a File list straight to an upload — the drop
// target, which already has the files and has nothing to pick.
export { UploadFilesAction, NavigateAction, SearchAction };
