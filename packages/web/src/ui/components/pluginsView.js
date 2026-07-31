import { dd } from '../../runtime.js';
import { icon } from '../icon.js';
import { CloseDialogAction, OpenPluginPanelAction, SetSettingAction, ShowDialogAction, UninstallPluginAction } from '../../bl/actions.js';

const { div, span, p, button, h2, input, label } = dd;

export default function pluginsView(state, ui) {
  const plugins = state.plugins || [];
  return div({ className: 'editor' },
    div({ className: 'stage' },
      div({ className: 'plugins' },
        h2('Plugins'),
        p({ className: 'sub', $styling: { color: 'var(--text-dim)', margin: '0 0 8px' } },
          'Plugins are sandboxed packages you install from a file or URL. They run in an isolated iframe and reach Trove only through a message channel, using the capabilities you granted.'),
        div({ className: 'plugin-install' },
          button({ className: 'btn primary' }, icon('upload', { size: 15 }), 'Install from file…')
            .on({ click: () => ui.exec('plugins.installFromFile') }),
          button({ className: 'btn' }, icon('plug', { size: 15 }), 'Install from URL…')
            .on({ click: () => ui.exec('plugins.installFromUrl') }),
        ),
        plugins.length
          ? div({ $styling: { display: 'flex', 'flex-direction': 'column', gap: '12px', 'margin-top': '14px' } }, ...plugins.map((pl) => installedCard(pl, state, ui)))
          : div({ className: 'empty', $styling: { padding: '48px' } }, icon('plug', { size: 30 }), span('No plugins installed yet.')),
      ),
    ),
  );
}

function installedCard(pl, state, ui) {
  const connectivity = !pl.responsive ? 'not responding' : pl.manifest?.online === false ? 'offline' : 'connected';
  const features = pl.features || [];
  return div({ className: 'plugin-card' },
    div({ className: 'top' },
      div({ className: 'avatar' }, (pl.name || '?')[0].toUpperCase()),
      div({ $styling: { flex: '1' } },
        div({ className: 'name' }, pl.name, pl.version ? span({ $styling: { color: 'var(--text-faint)', 'font-weight': '400', 'margin-left': '6px' } }, 'v' + pl.version) : null),
        div({ $styling: { 'font-size': '11px', color: 'var(--text-faint)' } }, pl.id),
      ),
      trustBadge(pl.trust),
      span({ className: `status ${pl.status}` }, pl.status),
    ),
    pl.error ? div({ className: 'desc', $styling: { color: 'var(--danger)' } }, pl.error) : null,
    div({ className: 'caps' }, ...(pl.capabilities || []).map((c) => span({ className: 'cap' }, c))),
    (pl.endpoints || []).length
      ? div({ className: 'plugin-endpoints', $styling: { 'font-size': '11px', color: 'var(--text-faint)', 'margin-top': '2px' } },
          icon('plug', { size: 11 }), ' Network: ', (pl.endpoints || []).map((e) => e.host).join(', '))
      : null,
    pl.status === 'active'
      ? div({ className: 'plugin-features' },
          div({ className: 'pf-head' }, span(`Features · ${connectivity}`), span({ className: 'muted' }, `${features.filter((f) => f.available).length}/${features.length} available`)),
          features.length
            ? div({ className: 'pf-list' }, ...features.map(featureRow))
            : div({ className: 'muted', $styling: { 'font-size': '12px' } }, pl.responsive ? 'No contributions announced.' : 'No manifest received — the plugin may not be running.'),
        )
      : null,
    (pl.settingsSchema || []).length ? settingsSection(pl, ui) : null,
    div({ className: 'actions' },
      pl.hasUi ? button({ className: 'btn' }, icon('command', { size: 14 }), 'Open panel').on({ click: () => ui.go(new OpenPluginPanelAction(pl.id)) }) : null,
      button({ className: 'btn' }, icon('refresh', { size: 14 }), 'Refresh').on({ click: () => ui.platform.plugins.refresh(pl.id) }),
      button({ className: 'btn danger' }, 'Uninstall').on({
        click: () => ui.go(new ShowDialogAction({
          kind: 'confirm', title: `Uninstall ${pl.name}?`, danger: true, confirmLabel: 'Uninstall',
          body: 'The plugin and all data it stored will be removed.',
          confirmActions: [new UninstallPluginAction(pl.id)],
        })),
      }),
    ),
  );
}

function settingsSection(pl, ui) {
  return div({ className: 'plugin-features' },
    div({ className: 'pf-head' }, span('Settings')),
    div({ $styling: { display: 'flex', 'flex-direction': 'column', gap: '8px' } },
      ...pl.settingsSchema.map((s) => settingRow(pl, s, ui)),
    ),
  );
}

function settingRow(pl, s, ui) {
  const key = `${pl.id}.${s.key}`;
  const value = s.secret ? '' : (ui.platform.settings.get(key) ?? s.default ?? '');
  return div({ className: 'setting', $styling: { padding: '6px 0' } },
    div({ className: 'info' }, div({ className: 't' }, s.title || s.key), s.description ? div({ className: 'd' }, s.description) : null),
    div({ className: 'control' },
      s.secret
        ? input({ className: 'input', type: 'password', placeholder: 'Set secret…' }).on({
            change: (e) => { if (e.target.value) { ui.platform.plugins.setSecret(pl.id, s.key, e.target.value); e.target.value = ''; e.target.placeholder = 'Saved ✓'; } },
          })
        : s.type === 'boolean'
          ? label({ className: 'switch' }, input({ type: 'checkbox', checked: !!value }).on({ change: (e) => ui.go(new SetSettingAction(key, e.target.checked)) }), span({ className: 'track' }))
          : input({ className: 'input', value }).on({ change: (e) => ui.go(new SetSettingAction(key, e.target.value)) }),
    ),
  );
}

function trustBadge(t) {
  if (!t) return null;
  if (t.status === 'verified') return span({ className: 'trust verified', title: 'Signed by ' + t.domain }, icon('check', { size: 12 }), t.domain);
  if (t.status === 'signed') return span({ className: 'trust signed' }, icon('info', { size: 12 }), 'signed');
  // A BROKEN signature is not the same as no signature. The install dialog says so in
  // red; this list used to fall through to the same amber "unverified" an ordinary
  // unsigned plugin gets, so a package whose signature failed to verify — the one case
  // that means someone tampered with it — looked like the common, benign one.
  if (t.status === 'invalid') {
    return span({ className: 'trust invalid', title: t.reason || 'The signature did not verify — this package may have been altered' },
      icon('warn', { size: 12 }), 'invalid signature');
  }
  return span({ className: 'trust unverified' }, icon('warn', { size: 12 }), 'unverified');
}

const KIND_ICON = { command: 'command', opener: 'file', indexer: 'search', statusItem: 'info' };
function featureRow(f) {
  return div({ className: `pf-row ${f.available ? '' : 'off'}` },
    icon(KIND_ICON[f.kind] || 'command', { size: 13 }),
    span({ className: 'pf-title' }, f.title),
    span({ className: 'pf-kind' }, f.kind),
    f.offline ? span({ className: 'pf-badge offline-ok', title: 'Works offline' }, 'offline ✓') : null,
    span({ className: `pf-dot ${f.available ? 'on' : 'no'}`, title: f.available ? 'Available now' : 'Unavailable now' }),
  );
}
