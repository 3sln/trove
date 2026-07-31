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
import { usageChip } from './statusBar.js';
import { CloseSheetAction, ExecCommandAction, OpenSheetAction, ToggleActivityPanelAction, ToggleInboxAction } from '../../bl/actions.js';

const { div, button, span, img } = dd;

// The tabs that earn a permanent slot. Everything else lives in More — a bottom bar with
// six items is a bottom bar nobody can hit.
const TABS = [
  { id: 'home', icon: 'search', label: 'Files', command: 'workbench.view.home' },
  { id: 'upload', icon: 'upload', label: 'Upload', command: 'explorer.upload' },
  { id: 'plugins', icon: 'plug', label: 'Plugins', command: 'workbench.view.plugins' },
];

// How to DRAW each condition. Which condition is the one worth showing — offline over a
// standing problem, a standing problem over work in progress — is decided by the
// `statusFacts` query, because that ordering is a claim about what a person most needs to
// know rather than a question about glyphs. See bl/status.js.
const GLYPHS = {
  offline: { icon: 'info', tone: 'warn' },
  issues: { icon: 'warn', tone: 'danger' },
  working: { spinner: true, tone: '' },
  lowSpace: { icon: 'info', tone: 'warn' },
  idle: { icon: 'info', tone: '' },
};

export function phoneTopBar(state, ui) {
  const f = state.facts;
  const c = f.condition;
  const g = { ...(GLYPHS[c.kind] || GLYPHS.idle), label: c.label, badge: c.kind === 'issues' ? c.count : 0 };
  // Where you are, at the coarsest level. Deliberately NOT the open file's name: the
  // viewer's own breadcrumb sits directly beneath this bar and already says that, and two
  // rows of chrome repeating "notes.txt" costs a fifth of the screen to say it twice.
  const title = state.wb.activity === 'settings' ? 'Settings'
    : state.wb.activity === 'plugins' ? 'Plugins'
      : f.collectionLabel;
  return div({ className: 'phonebar top' },
    button({ className: 'pb-brand', title: 'Trove — home' }, img({ src: '/icon.svg', alt: 'Trove' }))
      .on({ click: () => ui.engine.dispatch(new ExecCommandAction('workbench.view.home')) }),
    div({ className: 'pb-title' }, title),
    button({ className: `pb-status ${g.tone}`, title: g.label, $attrs: { 'aria-label': g.label } },
      g.spinner
        ? div({ className: 'spinner', $styling: { width: '15px', height: '15px' } })
        : icon(g.icon, { size: 18 }),
      g.badge ? span({ className: 'pb-badge' }, String(g.badge > 9 ? '9+' : g.badge)) : null,
    ).on({ click: () => ui.engine.dispatch(new OpenSheetAction('status')) }),
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
      .on({ click: () => { ui.engine.dispatch(new CloseSheetAction()); ui.engine.dispatch(new ExecCommandAction(t.command)); } })),
    // Settings is reached FROM the More sheet, so while you are in it "More" is where
    // you are — otherwise all four tabs read as inactive and the bar claims you are
    // nowhere.
    button({
      className: `pb-tab ${sheet === 'more' || (!sheet && !TABS.some((t) => t.id === active)) ? 'active' : ''}`,
      $attrs: { 'aria-label': 'More' },
    },
      icon('dots', { size: 21 }),
      unread ? span({ className: 'pb-badge' }, String(unread > 9 ? '9+' : unread)) : null,
      span({ className: 'pb-label' }, 'More'),
    ).on({ click: () => ui.engine.dispatch(new OpenSheetAction('more')) }),
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
  return div({ className: 'sheet-wrap' },
    div({ className: 'scrim' }).on({ click: () => ui.engine.dispatch(new CloseSheetAction()) }),
    div({ className: 'sheet' },
      div({ className: 'sheet-grip' }).on({ click: () => ui.engine.dispatch(new CloseSheetAction()) }),
      which === 'status' ? statusSheet(state, ui) : moreSheet(state, ui),
    ),
  );
}

function statusSheet(state, ui) {
  const f = state.facts;
  const go = (cmd) => () => { ui.engine.dispatch(new CloseSheetAction()); ui.engine.dispatch(new ExecCommandAction(cmd)); };
  return div({ className: 'sheet-body' },
    div({ className: 'sheet-title' }, f.collectionLabel),

    // Problems and running work first: they are the reason someone opened this.
    f.issues.length
      ? sheetRow({
        icon: 'warn', danger: true,
        label: `${f.issues.length} need${f.issues.length === 1 ? 's' : ''} attention`,
        onClick: () => { ui.engine.dispatch(new CloseSheetAction()); ui.engine.dispatch(new ToggleActivityPanelAction(true)); },
      })
      : null,
    f.running.length || f.uploading.length
      ? sheetRow({
        icon: 'refresh',
        label: `${f.running.length + f.uploading.length} running`,
        onClick: () => { ui.engine.dispatch(new CloseSheetAction()); ui.engine.dispatch(new ToggleActivityPanelAction(true)); },
      })
      : null,
    !f.off.online ? sheetRow({ icon: 'info', label: 'Offline', value: `${f.off.pins.length} pinned` }) : null,
    f.off.queued ? sheetRow({ icon: 'upload', label: 'Waiting to sync', value: String(f.off.queued) }) : null,

    sheetRow({
      icon: 'files',
      label: 'Items',
      value: f.partial
        ? `${f.shown.toLocaleString()} of ${f.totalKnown ? f.totalItems.toLocaleString() : 'more'}`
        : f.totalItems.toLocaleString(),
    }),
    // `+` where the figure covers only what has loaded, matching the desktop bar.
    sheetRow({ icon: 'file', label: 'Size', value: `${bytes(f.totalBytes)}${f.totalKnown || !f.partial ? '' : '+'}` }),
    // Only where the backend can actually answer — see usageChip.
    f.usage?.total
      ? div({ className: 'sheet-row static usage' },
        icon('download', { size: 18 }),
        span({ className: 'sr-label' }, 'Free space'),
        usageChip(f))
      : null,
    state.caps ? sheetRow({
      icon: state.caps.storage?.presignDownload ? 'download' : 'files',
      label: 'Transfers',
      value: state.caps.storage?.presignDownload ? 'Direct to storage' : 'Through the server',
    }) : null,
    state.caps?.features?.semanticSearch ? sheetRow({ icon: 'star', label: 'Search', value: 'Semantic + keyword' }) : null,

    div({ className: 'sheet-actions' },
      button({ className: 'btn small ghost' }, icon('refresh', { size: 13 }), span('Scan for changes')).on({ click: go('workbench.scanCollection') }),
      button({ className: 'btn small ghost' }, icon('refresh', { size: 13 }), span('Activity'))
        .on({ click: () => { ui.engine.dispatch(new CloseSheetAction()); ui.engine.dispatch(new ToggleActivityPanelAction(true)); } }),
    ),
  );
}

function moreSheet(state, ui) {
  const go = (cmd) => () => { ui.engine.dispatch(new CloseSheetAction()); ui.engine.dispatch(new ExecCommandAction(cmd)); };
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

    sheetRow({ icon: 'bell', label: unread ? `Notifications (${unread})` : 'Notifications', onClick: () => { ui.engine.dispatch(new CloseSheetAction()); ui.engine.dispatch(new ToggleInboxAction(true)); } }),
    sheetRow({ icon: 'refresh', label: 'Activity & problems', onClick: () => { ui.engine.dispatch(new CloseSheetAction()); ui.engine.dispatch(new ToggleActivityPanelAction(true)); } }),
    sheetRow({ icon: 'info', label: 'Details & conversation', onClick: go('workbench.toggleInfoPanel') }),
    sheetRow({ icon: 'trash', label: 'Trash', onClick: go('explorer.showTrash') }),
    sheetRow({ icon: 'refresh', label: 'Refresh', onClick: go('explorer.refresh') }),
    sheetRow({ icon: 'command', label: 'All commands', onClick: go('workbench.showCommandPalette') }),
    sheetRow({ icon: 'gear', label: 'Settings', onClick: go('workbench.openSettings') }),
  );
}
