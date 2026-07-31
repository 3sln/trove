// The built-in context keys, DERIVED.
//
// Every key here is a function of a resource's state. That is not a refactor of where the
// writes live — it removes the writes. A derived key cannot be forgotten when a new code
// path changes the thing it summarises, which is the failure the old shape kept producing:
// `explorer.hasSelection` was set by NavigateAction and by nothing else, so selecting a file
// in the launcher left it false and the Delete keybinding silently did nothing.
//
// Registered in one place because that is what makes the list reviewable. A when-clause is
// only as trustworthy as the least-maintained key it names, and they were spread across five
// services.

import { derive } from '../runtime.js';

/**
 * Register every built-in key against the resources it is derived from.
 *
 * @param {import('../platform/context.js').ContextRegistry} registry
 * @param {object} r the resources these summarise
 * @returns {() => void} unregister them all
 */
export function registerCoreContext(registry, { workbench, explorer }) {
  const wb = workbench.observe();
  const nav = workbench.observeNav();
  const overlay = workbench.observeOverlay();
  const ex = explorer.observe();

  const keys = {
    // Which screen is showing. Seeded as 'home' because that is where the app starts, and a
    // `when: view.active == 'home'` binding — the Delete shortcut among them — was dead from
    // boot until the first click on the rail when nothing had written the key yet.
    'view.active': derive([wb], (s) => s.activity),
    'sidebar.visible': derive([wb], (s) => s.sidebarVisible),
    'searchModal.open': derive([wb], (s) => !!s.searchModal),
    'sheet.open': derive([wb], (s) => s.sheet || ''),
    'infoPanel.open': derive([wb], (s) => !!s.infoPanel),

    'palette.open': derive([overlay], (s) => !!s.palette),

    // What is open in the viewer, for openers and viewer-scoped shortcuts.
    'editor.open': derive([nav], (s) => !!s.activeFile),
    'editor.openerId': derive([nav], (s) => s.stack?.at(-1)?.openerId || ''),
    'editor.contentType': derive([nav], (s) => s.activeFile?.contentType || ''),

    // `null` when no collection is open, never the string 'default'. A when-clause reading
    // this is asking WHICH collection is open, and answering with the name of one that may
    // not exist made every such clause true before the user had chosen anything.
    'explorer.collectionId': derive([ex], (s) => s.collectionId ?? null),
    'explorer.hasSelection': derive([ex], (s) => (s.selection?.length || 0) > 0),
  };

  const offs = Object.entries(keys).map(([key, source]) => registry.register(key, source));
  return () => offs.forEach((off) => off());
}

/**
 * The viewport's keys, registered separately because the viewport is measured rather than
 * derived from a resource — it comes from the window, and the service already holds a cell
 * of what it measured.
 */
export function registerViewportContext(registry, viewport) {
  const vp = viewport.observe();
  const offs = [
    registry.register('viewport.mode', derive([vp], (s) => s.mode)),
    registry.register('viewport.phone', derive([vp], (s) => s.mode === 'phone')),
    registry.register('viewport.tv', derive([vp], (s) => s.mode === 'tv')),
  ];
  return () => offs.forEach((off) => off());
}
