import { dd } from '../../runtime.js';
import { icon } from '../icon.js';
import { prettyKey } from '../../platform/keybindings.js';
import { notificationBell, principalChip } from './social.js';

const { div, span, img, button } = dd;

export default function titleBar(state, ui) {
  const paletteKey = ui.platform.keybindings.labelFor('workbench.showCommandPalette') || prettyKey('mod+shift+p');
  return div({ className: 'titlebar' },
    div({ className: 'brand' }, img({ src: '/icon.svg', alt: '' }), span('Trove')),
    div({ className: 'center' },
      button({ className: 'omni', title: 'Search everything (semantic + keyword)' },
        icon('search', { size: 14 }),
        span('Search or run a command'),
        span({ className: 'kbd' }, dd.h('kbd', paletteKey)),
      ).on({ click: () => ui.exec('workbench.showCommandPalette') }),
    ),
    div({ className: 'titlebar-right' },
      button({ className: `iconbtn ${state.wb.infoPanel ? 'active' : ''}`, title: 'Details & conversation' }, icon('info', { size: 17 }))
        .on({ click: () => ui.exec('workbench.toggleInfoPanel') }),
      notificationBell(state, ui),
      button({ className: 'iconbtn', title: 'Settings' }, icon('gear', { size: 17 }))
        .on({ click: () => ui.exec('workbench.openSettings') }),
      principalChip(state),
    ),
  );
}
