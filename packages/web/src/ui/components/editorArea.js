// The viewer — the top of the panel stack (a file's opener), full-width, with a
// nav bar: a Back button, a trail of the stacked panels (Search › A › B),
// and details/close actions. The opener host returns a *stable* keyed alias per
// panel so dodo reuses its DOM across unrelated workbench re-renders — critical for
// any media opener, whose <audio>/<video> must keep playing while state churns; the
// DOM persists as long as the panel stays in the stack.

import { dd } from '../../runtime.js';
import { icon, iconForNode } from '../icon.js';
import { renderOpener } from './openers/index.js';
import { openersFor } from '../../bl/openers.js';
import { NavigateBackAction, OpenInPanelAction, ShowDialogAction, ShowHomeAction, ToggleInfoPanelAction } from '../../bl/actions.js';

const { div, span, button } = dd;

/**
 * `${panelId}:${openerId}` -> stable render fn.
 *
 * dodo identifies an alias by the FUNCTION, so a fresh one per render would rebuild it
 * every pass and take the <audio> with it. Module scope is safe here in a way it was not
 * for the keybindings region, and the difference is the key: a panel id is minted by
 * `newId()` and is unique across every workbench on the page, so two shells cannot collide
 * and hand each other's `ui` to a render. `pruneOpeners` bounds it to the live stack.
 */
const openerFns = new Map();

export default function editorArea(state, ui) {
  const wb = state.wb;
  const files = state.nav.stack.filter((p) => p.kind === 'file');
  pruneOpeners(files);
  const active = files[files.length - 1];
  if (!active) return div({ className: 'editor' });
  return div({ className: 'editor' },
    navBar(files, active, state, ui),
    div({ className: 'stage' }, openerHost(active, ui)),
  );
}

function navBar(files, active, state, ui) {
  return div({ className: 'viewer-nav' },
    button({ className: 'vn-back', title: 'Back (Esc)' }, icon('chevron-left', { size: 16 }))
      .on({ click: () => ui.engine.dispatch(new NavigateBackAction()) }),
    div({ className: 'vn-trail' },
      button({ className: 'vn-crumb' }, icon('search', { size: 13 }), span('Search'))
        .on({ click: () => ui.engine.dispatch(new ShowHomeAction()) }),
      ...files.map((p) =>
        button({ className: `vn-crumb ${p.id === active.id ? 'active' : ''}`, title: p.node.name },
          icon(iconForNode(p.node), { size: 13 }), span({ className: 'label' }, p.node.name))
          .on({ click: () => ui.engine.dispatch(new OpenInPanelAction(p.node, p.openerId)) })),
    ),
    div({ className: 'vn-actions' },
      openerSwitch(active, state, ui),
      button({ className: 'iconbtn', title: 'Details & comments' }, icon('info', { size: 15 }))
        .on({ click: () => ui.engine.dispatch(new ToggleInfoPanelAction()) }),
      button({ className: 'iconbtn', title: 'Close (Esc)' }, icon('close', { size: 15 }))
        .on({ click: () => ui.engine.dispatch(new ShowHomeAction()) }),
    ),
  );
}

// "Open with…" — shown only when more than one opener can handle this file. Opens
// the chooser (pre-selected to the current opener) so the user can switch viewers,
// and optionally make the choice their default for this file type.
function openerSwitch(active, state, ui) {
  // `state.openers` has already had its when-clauses and plugin health resolved by the
  // query; matching them against THIS file is pure. That split is why this no longer
  // reaches for the contribution registry mid-render.
  const openers = openersFor(state.openers, active.node);
  if (openers.length <= 1) return null;
  return button({ className: 'iconbtn', title: 'Open with…' }, icon('dots', { size: 15 }))
    .on({ click: () => ui.engine.dispatch(new ShowDialogAction({ kind: 'opener-chooser', node: active.node, openers, current: active.openerId })) });
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
