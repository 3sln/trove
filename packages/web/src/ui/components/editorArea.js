// The viewer — the top of the panel stack (a file's opener), full-width, with a
// nav bar: a Back button, a breadcrumb trail of the stacked panels (Search › A › B),
// and details/close actions. The opener host returns a *stable* keyed alias per
// panel so dodo reuses its DOM across unrelated workbench re-renders — critical for
// the audiobook player, whose <audio> must keep playing while state churns; the
// DOM persists as long as the panel stays in the stack.

import { dd } from '../../runtime.js';
import { icon, iconForNode } from '../icon.js';
import { renderOpener } from './openers/index.js';
import { availableOpeners } from '../../bl/openers.js';

const { div, span, button } = dd;

const openerFns = new Map(); // `${panelId}:${openerId}` -> stable render fn

export default function editorArea(state, ui) {
  const wb = state.wb;
  const files = wb.stack.filter((p) => p.kind === 'file');
  pruneOpeners(files);
  const active = files[files.length - 1];
  if (!active) return div({ className: 'editor' });
  return div({ className: 'editor' },
    navBar(files, active, ui),
    div({ className: 'stage' }, openerHost(active, ui)),
  );
}

function navBar(files, active, ui) {
  const w = ui.platform.workbench;
  return div({ className: 'viewer-nav' },
    button({ className: 'vn-back', title: 'Back (Esc)' }, icon('chevron-left', { size: 16 }))
      .on({ click: () => w.back() }),
    div({ className: 'vn-trail' },
      button({ className: 'vn-crumb' }, icon('search', { size: 13 }), span('Search'))
        .on({ click: () => w.showHome() }),
      ...files.map((p) =>
        button({ className: `vn-crumb ${p.id === active.id ? 'active' : ''}`, title: p.node.path },
          icon(iconForNode(p.node), { size: 13 }), span({ className: 'label' }, p.node.name))
          .on({ click: () => w.openFile(p.node, p.openerId) })),
    ),
    div({ className: 'vn-actions' },
      openerSwitch(active, ui),
      button({ className: 'iconbtn', title: 'Details & comments' }, icon('info', { size: 15 }))
        .on({ click: () => w.toggleInfoPanel() }),
      button({ className: 'iconbtn', title: 'Close (Esc)' }, icon('close', { size: 15 }))
        .on({ click: () => w.showHome() }),
    ),
  );
}

// "Open with…" — shown only when more than one opener can handle this file. Opens
// the chooser (pre-selected to the current opener) so the user can switch viewers,
// and optionally make the choice their default for this file type.
function openerSwitch(active, ui) {
  const openers = availableOpeners(ui.platform, active.node);
  if (openers.length <= 1) return null;
  return button({ className: 'iconbtn', title: 'Open with…' }, icon('dots', { size: 15 }))
    .on({ click: () => ui.platform.workbench.showDialog({ kind: 'opener-chooser', node: active.node, openers, current: active.openerId }) });
}

function openerHost(panel, ui) {
  const key = `${panel.id}:${panel.openerId}`;
  let fn = openerFns.get(key);
  if (!fn) {
    fn = () => renderOpener(panel.node, panel.openerId, ui);
    openerFns.set(key, fn);
  }
  return dd.alias(fn)().key(panel.id);
}

function pruneOpeners(files) {
  const live = new Set(files.map((p) => `${p.id}:${p.openerId}`));
  for (const k of openerFns.keys()) if (!live.has(k)) openerFns.delete(k);
}
