// The phone shell: a thin top bar, a bottom tab bar, and two sheets.
//
// A left rail costs 52px of a 390px-wide screen and a status bar costs a row of chrome
// that is unreadable at that size anyway — on a phone both are worse than useless. So
// the rail's destinations become bottom tabs (thumb-reachable, which the top of the
// screen is not), everything past the first few becomes one "More" sheet, and the whole
// status bar folds behind a single icon in the top bar.
//
// The icon is not decoration: it changes to say what is happening. Work running shows a
// spinner, a standing problem shows a badge, and neither is something the user has to go
// looking for. Everything else — item counts, free space, backend — is a tap away rather
// than permanently on screen, because on a phone it is reference material, not status.

import { dd } from '../../runtime.js';
import { icon } from '../icon.js';
import { bytes } from '../format.js';
import { statusFacts, usageChip } from './statusBar.js';

const { div, button, span, img } = dd;

// The tabs that earn a permanent slot. Everything else lives in More — a bottom bar with
// six items is a bottom bar nobody can hit.
const TABS = [
  { id: 'home', icon: 'search', label: 'Files', command: 'workbench.view.home' },
  { id: 'upload', icon: 'upload', label: 'Upload', command: 'explorer.upload' },
  { id: 'plugins', icon: 'plug', label: 'Plugins', command: 'workbench.view.plugins' },
];

/** Which single glyph best describes the drive's state right now. */
function statusGlyph(f) {
  if (!f.off.online) return { icon: 'info', tone: 'warn', label: 'Offline' };
  if (f.issues.length) return { icon: 'warn', tone: 'danger', label: `${f.issues.length} need attention`, badge: f.issues.length };
  if (f.running.length || f.uploading.length || f.off.syncing) return { spinner: true, tone: '', label: 'Working…' };
  if (f.usage?.total && f.usage.available / f.usage.total < 0.1) return { icon: 'info', tone: 'warn', label: 'Low on space' };
  return { icon: 'info', tone: '', label: 'Status' };
}

export function phoneTopBar(state, ui) {
  const f = statusFacts(state, ui);
  const g = statusGlyph(f);
  // Where you are, at the coarsest level. Deliberately NOT the open file's name: the
  // viewer's own breadcrumb sits directly beneath this bar and already says that, and two
  // rows of chrome repeating "notes.txt" costs a fifth of the screen to say it twice.
  const title = state.wb.activity === 'settings' ? 'Settings'
    : state.wb.activity === 'plugins' ? 'Plugins'
      : f.collectionId;
  return div({ className: 'phonebar top' },
    button({ className: 'pb-brand', title: 'Trove — home' }, img({ src: '/icon.svg', alt: 'Trove' }))
      .on({ click: () => ui.exec('workbench.view.home') }),
    div({ className: 'pb-title' }, title),
    button({ className: `pb-status ${g.tone}`, title: g.label, $attrs: { 'aria-label': g.label } },
      g.spinner
        ? div({ className: 'spinner', $styling: { width: '15px', height: '15px' } })
        : icon(g.icon, { size: 18 }),
      g.badge ? span({ className: 'pb-badge' }, String(g.badge > 9 ? '9+' : g.badge)) : null,
    ).on({ click: () => ui.platform.workbench.openSheet('status') }),
  );
}

export function phoneBottomBar(state, ui) {
  const active = state.wb.activity;
  const sheet = state.wb.sheet;
  const unread = state.so.notifications.unread;
  return div({ className: 'phonebar bottom' },
    ...TABS.map((t) => button({
      className: `pb-tab ${!sheet && active === t.id ? 'active' : ''}`,
      $attrs: { 'aria-label': t.label },
    }, icon(t.icon, { size: 21 }), span({ className: 'pb-label' }, t.label))
      .on({ click: () => { ui.platform.workbench.closeSheet(); ui.exec(t.command); } })),
    button({ className: `pb-tab ${sheet === 'more' ? 'active' : ''}`, $attrs: { 'aria-label': 'More' } },
      icon('dots', { size: 21 }),
      unread ? span({ className: 'pb-badge' }, String(unread > 9 ? '9+' : unread)) : null,
      span({ className: 'pb-label' }, 'More'),
    ).on({ click: () => ui.platform.workbench.openSheet('more') }),
  );
}

/** A row in a sheet: an icon, a label, and either a value or a chevron. */
function sheetRow({ icon: name, label, value, danger, onClick }) {
  const body = [
    icon(name, { size: 18 }),
    span({ className: 'sr-label' }, label),
    value != null ? span({ className: 'sr-value' }, value) : null,
    onClick ? icon('chevron-right', { size: 16, className: 'sr-go' }) : null,
  ];
  return onClick
    ? button({ className: `sheet-row ${danger ? 'danger' : ''}` }, ...body).on({ click: onClick })
    : div({ className: 'sheet-row static' }, ...body);
}

export function phoneSheet(state, ui) {
  const which = state.wb.sheet;
  if (!which) return null;
  const wb = ui.platform.workbench;
  return div({ className: 'sheet-wrap' },
    div({ className: 'scrim' }).on({ click: () => wb.closeSheet() }),
    div({ className: 'sheet' },
      div({ className: 'sheet-grip' }).on({ click: () => wb.closeSheet() }),
      which === 'status' ? statusSheet(state, ui) : moreSheet(state, ui),
    ),
  );
}

function statusSheet(state, ui) {
  const f = statusFacts(state, ui);
  const wb = ui.platform.workbench;
  const go = (cmd) => () => { wb.closeSheet(); ui.exec(cmd); };
  return div({ className: 'sheet-body' },
    div({ className: 'sheet-title' }, f.collectionId),

    // Problems and running work first: they are the reason someone opened this.
    f.issues.length
      ? sheetRow({
        icon: 'warn', danger: true,
        label: `${f.issues.length} need${f.issues.length === 1 ? 's' : ''} attention`,
        onClick: () => { wb.closeSheet(); ui.app.activity.togglePanel(true); },
      })
      : null,
    f.running.length || f.uploading.length
      ? sheetRow({
        icon: 'refresh',
        label: `${f.running.length + f.uploading.length} running`,
        onClick: () => { wb.closeSheet(); ui.app.activity.togglePanel(true); },
      })
      : null,
    !f.off.online ? sheetRow({ icon: 'info', label: 'Offline', value: `${f.off.pins.length} pinned` }) : null,
    f.off.queued ? sheetRow({ icon: 'upload', label: 'Waiting to sync', value: String(f.off.queued) }) : null,

    sheetRow({
      icon: 'files',
      label: 'Items',
      value: f.partial
        ? `${f.shown.toLocaleString()} of ${f.totalItems.toLocaleString()}`
        : f.totalItems.toLocaleString(),
    }),
    sheetRow({ icon: 'file', label: 'Size', value: bytes(f.totalBytes) }),
    // Only where the backend can actually answer — see usageChip.
    f.usage?.total
      ? div({ className: 'sheet-row static usage' },
        icon('download', { size: 18 }),
        span({ className: 'sr-label' }, 'Free space'),
        usageChip({ usage: f.usage }))
      : null,
    f.caps ? sheetRow({
      icon: f.caps.storage?.presignDownload ? 'download' : 'files',
      label: 'Transfers',
      value: f.caps.storage?.presignDownload ? 'Direct to storage' : 'Through the server',
    }) : null,
    f.caps?.features?.semanticSearch ? sheetRow({ icon: 'star', label: 'Search', value: 'Semantic + keyword' }) : null,

    div({ className: 'sheet-actions' },
      button({ className: 'btn small ghost' }, icon('refresh', { size: 13 }), span('Scan for changes')).on({ click: go('workbench.scanCollection') }),
      button({ className: 'btn small ghost' }, icon('refresh', { size: 13 }), span('Activity'))
        .on({ click: () => { ui.platform.workbench.closeSheet(); ui.app.activity.togglePanel(true); } }),
    ),
  );
}

function moreSheet(state, ui) {
  const wb = ui.platform.workbench;
  const go = (cmd) => () => { wb.closeSheet(); ui.exec(cmd); };
  const me = state.so.me;
  const unread = state.so.notifications.unread;
  return div({ className: 'sheet-body' },
    // No identity, no profile row — the same rule the desktop rail follows. An anonymous
    // deployment has no account to show and nothing to sign into.
    me && !me.anonymous
      ? div({ className: 'sheet-me' },
        me.picture ? img({ src: me.picture, alt: '', className: 'avatar-img' }) : span({ className: 'avatar-txt' }, (me.name || me.id || '?')[0].toUpperCase()),
        div({}, div({ className: 'sm-name' }, me.name || me.id), me.email ? div({ className: 'sm-sub' }, me.email) : null))
      : null,

    sheetRow({ icon: 'bell', label: unread ? `Notifications (${unread})` : 'Notifications', onClick: () => { wb.closeSheet(); ui.app.social.toggleInbox(true); } }),
    sheetRow({ icon: 'refresh', label: 'Activity & problems', onClick: () => { wb.closeSheet(); ui.app.activity.togglePanel(true); } }),
    sheetRow({ icon: 'info', label: 'Details & conversation', onClick: go('workbench.toggleInfoPanel') }),
    sheetRow({ icon: 'trash', label: 'Trash', onClick: go('explorer.showTrash') }),
    sheetRow({ icon: 'refresh', label: 'Refresh', onClick: go('explorer.refresh') }),
    sheetRow({ icon: 'command', label: 'All commands', onClick: go('workbench.showCommandPalette') }),
    sheetRow({ icon: 'gear', label: 'Settings', onClick: go('workbench.openSettings') }),
  );
}
