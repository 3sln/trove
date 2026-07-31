// The pre-install review — everything a user needs to decide whether to trust
// and install a plugin: its identity + signature/domain-verified status, the
// capabilities it wants (each explained, admin-only ones flagged), what it
// contributes, and its settings. Capabilities are opt-in checkboxes; admin-only
// ones are disabled for non-admins. No plugin code has run at this point.

import { dd } from '../../runtime.js';
import { icon } from '../icon.js';
import { bytes as fmtBytes } from '../format.js';
import { draftFor } from '../../bl/viewState.js';
import { CloseDialogAction, SetViewStateAction } from '../../bl/actions.js';

const { div, span, button, h3, p, label, input } = dd;

// The ticked capabilities, keyed to the dialog instance. Engine state — it decides which
// boxes render checked. See bl/viewState.js.
const KEY = 'pluginReview';

export function pluginReview(d, ui, view) {
  const s = d.summary;
  // Derived, not written: the default used to be installed during the render that noticed
  // the dialog had changed, which made rendering a side-effecting operation.
  const sel = draftFor(view, KEY, d, {
    // Default: request everything the user is allowed to grant.
    grants: s.capabilities.filter((c) => !c.adminOnly || d.isAdmin).map((c) => c.id),
  });
  // A new array rather than a mutated Set: the write has to be a different value for the
  // cell to see it as a change at all.
  const toggle = (cap) => ui.go(new SetViewStateAction(KEY, {
    ref: sel.ref,
    grants: sel.grants.includes(cap) ? sel.grants.filter((c) => c !== cap) : [...sel.grants, cap],
  }));

  return div({},
    div({ className: 'scrim' }).on({ click: () => ui.go(new CloseDialogAction()) }),
    div({ className: 'dialog review', $styling: { width: 'min(560px, 96vw)' } },
      header(s),
      div({ className: 'review-body' },
        s.description ? p({ className: 'review-desc' }, s.description) : null,
        section('Capabilities it requests', s.capabilities.length
          ? div({ className: 'cap-list' }, ...s.capabilities.map((c) => capRow(c, d.isAdmin, sel.grants.includes(c.id), () => toggle(c.id))))
          : muted('None — this plugin only runs in its sandbox.')),
        (s.network || []).length ? section('Network access', div({ className: 'contrib-list' }, ...s.network.map(endpointRow))) : null,
        (s.commands || []).length
          ? section('Commands it can run', div({ className: 'contrib-list' }, ...s.commands.map((id) => commandRow(id, ui))))
          : null,
        s.storage ? section('Storage', storageRows(s.storage)) : null,
        s.contributions.length ? section('What it adds', div({ className: 'contrib-list' }, ...s.contributions.map(contribRow))) : null,
        s.settings.length ? section('Settings', div({ className: 'contrib-list' }, ...s.settings.map(settingRow))) : null,
        div({ className: 'review-meta' }, `${s.fileCount} files · ${fmtBytes(s.sizeBytes)} · id ${s.id}`),
      ),
      div({ className: 'row-actions' },
        button({ className: 'btn' }, 'Cancel').on({ click: () => ui.go(new CloseDialogAction()) }),
        button({ className: 'btn primary' }, icon('plug', { size: 15 }), 'Install').on({ click: () => d.onInstall([...sel.grants]) }),
      ),
    ),
  );
}

function header(s) {
  const t = s.trust || { status: 'unverified' };
  return div({ className: 'review-head' },
    div({ className: 'avatar' }, (s.name || '?')[0].toUpperCase()),
    div({ className: 'rh-main' },
      div({ className: 'rh-name' }, s.name, span({ className: 'rh-ver' }, 'v' + s.version)),
      div({ className: 'rh-author' }, 'by ' + s.author),
    ),
    trustBadge(t),
  );
}

function trustBadge(t) {
  if (t.status === 'verified') {
    return span({ className: 'trust verified', title: `Signed by a key published at ${t.domain}` }, icon('check', { size: 13 }), 'Verified · ' + t.domain);
  }
  if (t.status === 'signed') {
    return span({ className: 'trust signed', title: t.reason || 'Signed, but the domain does not vouch for the key' }, icon('info', { size: 13 }), 'Signed');
  }
  if (t.status === 'invalid') {
    return span({ className: 'trust invalid', title: t.reason || 'Invalid signature — the package may have been tampered with' }, icon('warn', { size: 13 }), 'Invalid signature');
  }
  return span({ className: 'trust unverified', title: t.reason || 'This plugin is not signed' }, icon('warn', { size: 13 }), 'Unverified');
}

function capRow(cap, isAdmin, checked, onToggle) {
  const blocked = cap.adminOnly && !isAdmin;
  return label({ className: `cap-row ${blocked ? 'blocked' : ''}` },
    input({ type: 'checkbox', checked: checked && !blocked, disabled: blocked }).on({ change: () => !blocked && onToggle() }),
    div({ className: 'cap-info' },
      div({ className: 'cap-name' }, cap.id, cap.adminOnly ? span({ className: 'pf-badge', $styling: { color: 'var(--warn)', 'margin-left': '6px' } }, 'admin only') : null),
      div({ className: 'cap-desc' }, cap.description + (blocked ? ' — requires an administrator' : '')),
    ),
  );
}

function contribRow(c) {
  const kindIcon = { command: 'command', opener: 'file', indexer: 'search', statusItem: 'info', register: 'info', keymap: 'command' }[c.kind] || 'command';
  return div({ className: 'contrib-row' },
    icon(kindIcon, { size: 13 }),
    span({ className: 'cr-title' }, c.title),
    c.detail ? span({ className: 'cr-detail' }, c.detail) : null,
    c.offline ? span({ className: 'pf-badge offline-ok' }, 'offline') : null,
    span({ className: 'pf-kind' }, c.kind),
  );
}

// One command the plugin may ask the host to run. Resolved against the live registry
// so the user sees the human title and where it comes from (built-in vs another
// plugin) — an id like "explorer.delete" alone doesn't convey what it does.
function commandRow(id, ui) {
  const cmd = ui?.platform?.contributions?.get?.(id);
  const source = cmd?.pluginId ? 'plugin' : cmd ? 'built-in' : 'not installed';
  return div({ className: `contrib-row ${cmd ? '' : 'blocked'}` },
    icon('command', { size: 13 }),
    span({ className: 'cr-title' }, cmd?.title || id),
    span({ className: 'cr-detail' }, id),
    span({ className: 'pf-kind' }, source),
  );
}

function endpointRow(ep) {
  return div({ className: 'contrib-row' },
    icon('plug', { size: 13 }),
    span({ className: 'cr-title' }, ep.host),
    ep.path ? span({ className: 'cr-detail' }, ep.path) : null,
    span({ className: 'pf-kind' }, ep.scheme),
  );
}

function storageRows(st) {
  const rows = [];
  if (st.plugin) rows.push(storageRow('Private database', 'A SQLite store just for this plugin (server + this device).', false));
  if (st.domain) rows.push(storageRow('Shared database', `Shared with other plugins from ${'its domain'} (SQLite).`, st.domainBlocked));
  return div({ className: 'contrib-list' }, ...rows);
}
function storageRow(title, detail, blocked) {
  return div({ className: `contrib-row ${blocked ? 'blocked' : ''}` },
    icon('plug', { size: 13 }),
    span({ className: 'cr-title' }, title),
    span({ className: 'cr-detail' }, blocked ? detail + ' — needs a verified domain' : detail),
    blocked ? span({ className: 'pf-badge', $styling: { color: 'var(--warn)' } }, 'unavailable') : null,
  );
}

function settingRow(st) {
  return div({ className: 'contrib-row' },
    icon('gear', { size: 13 }),
    span({ className: 'cr-title' }, st.title),
    st.secret
      ? span({ className: 'pf-badge', $styling: { color: 'var(--warn)' } }, 'secret')
      : span({ className: 'pf-kind' }, st.type),
  );
}

function section(title, content) {
  return div({ className: 'review-section' }, div({ className: 'rs-title' }, title), content);
}
function muted(t) {
  return div({ className: 'muted', $styling: { 'font-size': '12.5px' } }, t);
}
