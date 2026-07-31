// The left rail — the app's only global chrome now that the title bar is gone.
// Brand mark at the top (→ home), the primary views below, then a bottom cluster
// of notifications, settings, and the signed-in principal. Search is reached from
// the Home view itself and via the double-shift modal, so there is no omni bar.

import { dd } from '../../runtime.js';
import { icon } from '../icon.js';
import { notificationBell, principalChip } from './social.js';
import { ExecCommandAction } from '../../bl/actions.js';

const { div, button, span, img } = dd;

const ITEMS = [
  { id: 'home', icon: 'search', title: 'Search & files', command: 'workbench.view.home' },
  { id: 'plugins', icon: 'plug', title: 'Plugins', command: 'workbench.view.plugins' },
];

export default function activityBar(state, ui) {
  const active = state.wb.activity;
  const pluginCount = state.plugins?.filter((p) => p.status === 'active').length || 0;
  return div({ className: 'activitybar' },
    button({ className: 'brand-mark', title: 'Trove — home' }, img({ src: '/icon.svg', alt: 'Trove' }))
      .on({ click: () => ui.engine.dispatch(new ExecCommandAction('workbench.view.home')) }),
    ...ITEMS.map((it) =>
      button({ className: `item ${active === it.id ? 'active' : ''}`, title: it.title },
        icon(it.icon, { size: 22 }),
        it.id === 'plugins' && pluginCount ? span({ className: 'badge' }, String(pluginCount)) : null,
      ).on({ click: () => ui.engine.dispatch(new ExecCommandAction(it.command)) }),
    ),
    div({ className: 'spacer' }),
    notificationBell(state, ui),
    button({ className: `item ${active === 'settings' ? 'active' : ''}`, title: 'Settings' }, icon('gear', { size: 21 }))
      .on({ click: () => ui.engine.dispatch(new ExecCommandAction('workbench.openSettings')) }),
    principalChip(state),
  );
}
