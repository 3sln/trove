import { dd } from '../../runtime.js';
import { icon } from '../icon.js';

const { div, span, p, button, h2 } = dd;

export default function pluginsView(state, ui) {
  const plugins = state.plugins || [];
  const available = ui.availablePlugins || [];
  const installedIds = new Set(plugins.map((p) => p.id));
  return div({ className: 'editor' },
    div({ className: 'stage' },
      div({ className: 'plugins' },
        h2('Plugins'),
        p({ className: 'sub', $styling: { color: 'var(--text-dim)', margin: '0 0 8px' } },
          'Plugins run in sandboxed iframes and talk to Trove only through a message channel. They can only use the capabilities they declare and you approve.'),
        ...plugins.map((pl) => installedCard(pl, ui)),
        ...available.filter((a) => !installedIds.has(a.id)).map((a) => availableCard(a, ui)),
        !plugins.length && !available.length
          ? div({ className: 'empty' }, icon('plug', { size: 30 }), span('No plugins available.'))
          : null,
      ),
    ),
  );
}

function installedCard(pl, ui) {
  return div({ className: 'plugin-card' },
    div({ className: 'top' },
      div({ className: 'avatar' }, (pl.name || '?')[0].toUpperCase()),
      div({}, div({ className: 'name' }, pl.name), div({ $styling: { fontSize: '11px', color: 'var(--text-faint)' } }, pl.id)),
      span({ className: `status ${pl.status}` }, pl.status),
    ),
    pl.error ? div({ className: 'desc', $styling: { color: 'var(--danger)' } }, pl.error) : null,
    div({ className: 'caps' }, ...(pl.capabilities || []).map((c) => span({ className: 'cap' }, c))),
    div({ className: 'actions' },
      pl.hasUi ? button({ className: 'btn' }, icon('command', { size: 14 }), 'Open panel')
        .on({ click: () => ui.platform.workbench.openPluginPanel(pl.id) }) : null,
      button({ className: 'btn danger' }, 'Uninstall').on({ click: () => ui.uninstallPlugin(pl.id) }),
    ),
  );
}

function availableCard(a, ui) {
  return div({ className: 'plugin-card' },
    div({ className: 'top' },
      div({ className: 'avatar' }, (a.name || '?')[0].toUpperCase()),
      div({}, div({ className: 'name' }, a.name), div({ $styling: { fontSize: '11px', color: 'var(--text-faint)' } }, a.id)),
      span({ className: 'status loading' }, 'available'),
    ),
    a.description ? div({ className: 'desc' }, a.description) : null,
    div({ className: 'caps' }, ...(a.capabilities || []).map((c) => span({ className: 'cap' }, c))),
    div({ className: 'actions' },
      button({ className: 'btn primary' }, icon('plus', { size: 14 }), 'Install')
        .on({ click: () => ui.installPlugin(a) }),
    ),
  );
}
