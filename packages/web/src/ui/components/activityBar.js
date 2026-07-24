import { dd } from '../../runtime.js';
import { icon } from '../icon.js';

const { div, button, span } = dd;

const ITEMS = [
  { id: 'home', icon: 'search', title: 'Home', command: 'workbench.view.home' },
  { id: 'plugins', icon: 'plug', title: 'Plugins', command: 'workbench.view.plugins' },
];

export default function activityBar(state, ui) {
  const active = state.wb.activity;
  const pluginCount = state.plugins?.filter((p) => p.status === 'active').length || 0;
  return div({ className: 'activitybar' },
    ...ITEMS.map((it) =>
      button({ className: `item ${active === it.id ? 'active' : ''}`, title: it.title },
        icon(it.icon, { size: 22 }),
        it.id === 'plugins' && pluginCount ? span({ className: 'badge' }, String(pluginCount)) : null,
      ).on({ click: () => ui.exec(it.command) }),
    ),
    div({ className: 'spacer' }),
    button({ className: `item ${active === 'settings' ? 'active' : ''}`, title: 'Settings' }, icon('gear', { size: 21 }))
      .on({ click: () => ui.exec('workbench.openSettings') }),
  );
}
