// The editor area: the tab strip plus the active opener's view. The opener host
// returns a *stable* keyed alias per tab so dodo reuses its DOM across unrelated
// workbench re-renders — critical for the audiobook player, whose <audio> must
// keep playing while toasts, uploads, and other state churn around it.

import { dd } from '../../runtime.js';
import { icon, iconForNode } from '../icon.js';
import { renderOpener } from './openers/index.js';
import { prettyKey } from '../../platform/keybindings.js';

const { div, span, button } = dd;

const openerFns = new Map(); // `${tabId}:${openerId}` -> stable render fn

export default function editorArea(state, ui) {
  const wb = state.wb;
  pruneOpeners(wb.tabs);
  const active = wb.tabs.find((t) => t.id === wb.activeTabId);
  return div({ className: 'editor' },
    wb.tabs.length ? tabStrip(wb, ui) : null,
    div({ className: 'stage' }, active ? openerHost(active, ui) : welcome(state, ui)),
  );
}

function tabStrip(wb, ui) {
  return div({ className: 'tabs' },
    ...wb.tabs.map((t) =>
      button({ className: `tab ${t.id === wb.activeTabId ? 'active' : ''}`, title: t.node.path },
        icon(iconForNode(t.node), { size: 14 }),
        span({ className: 'label' }, t.node.name),
        span({ className: 'close' }, icon('close', { size: 13 }))
          .on({ click: (e) => { e.stopPropagation(); ui.platform.workbench.closeTab(t.id); } }),
      ).key(t.id).on({ click: () => ui.platform.workbench.activateTab(t.id) }),
    ),
  );
}

function openerHost(tab, ui) {
  const key = `${tab.id}:${tab.openerId}`;
  let fn = openerFns.get(key);
  if (!fn) {
    fn = () => renderOpener(tab.node, tab.openerId, ui);
    openerFns.set(key, fn);
  }
  return dd.alias(fn)().key(tab.id);
}

function pruneOpeners(tabs) {
  const live = new Set(tabs.map((t) => `${t.id}:${t.openerId}`));
  for (const k of openerFns.keys()) if (!live.has(k)) openerFns.delete(k);
}

function welcome(state, ui) {
  const kp = (id, fallback) => ui.platform.keybindings.labelFor(id) || prettyKey(fallback);
  return div({ className: 'welcome' },
    div({ className: 'card' },
      div({ className: 'logo' }, '🗄️'),
      dd.h1('Welcome to Trove'),
      dd.p('Your self-hosted drive with semantic search, media players, and plugins.'),
      div({ className: 'hints' },
        hint(ui, 'search', 'Search everything', kp('workbench.showCommandPalette', 'mod+shift+p'), () => ui.exec('workbench.showCommandPalette')),
        hint(ui, 'upload', 'Upload files', kp('explorer.upload', 'mod+u'), () => ui.exec('explorer.upload')),
        hint(ui, 'star', 'Semantic search', kp('workbench.view.search', 'mod+shift+f'), () => ui.exec('workbench.view.search')),
        hint(ui, 'plug', 'Browse plugins', null, () => ui.exec('workbench.view.plugins')),
      ),
    ),
  );
}

function hint(ui, ic, label, key, onClick) {
  return div({ className: 'hint', $styling: { cursor: 'default' } },
    icon(ic, { size: 16 }),
    span({ $styling: { flex: '1' } }, label),
    key ? span({ className: 'kbd' }, dd.h('kbd', key)) : null,
  ).on({ click: onClick });
}
