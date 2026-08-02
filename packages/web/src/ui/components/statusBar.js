import { dd } from '../../runtime.js';
import { icon } from '../icon.js';
import { bytes } from '../format.js';
import { sanitizedVNodes, htmlToText } from '../sanitize.js';
import { CancelTransferAction, ExecCommandAction, ShowContextMenuAction, ToggleActivityPanelAction } from '../../bl/actions.js';

const { div, button, span } = dd;

/**
 * A plugin's status slot. The manifest declares the slot (name + side); the plugin
 * pushes content into it at runtime over RPC. The content is untrusted HTML from a
 * sandboxed frame, so it goes through the allowlist sanitizer before it becomes nodes.
 * A slot with nothing in it, or one whose `when` doesn't hold, renders nothing at all
 * rather than an empty chip.
 */
// The item arrives already decided — see the statusItems view query. Whether it should
// show at all (`visible`, its `when` clause, whether the plugin behind it is responding) is
// resolved on the query side now, which is what let this stop reaching into `platform`
// mid-render. `html` is still untrusted plugin markup: a query emitting plain data says
// nothing about that data being safe, so it is still sanitised here.
function statusSlot(item, ui) {
  const content = sanitizedVNodes(item.html, dd);
  if (!content.length) return null;
  const title = item.tooltip ? htmlToText(item.tooltip) : '';
  return item.command
    ? button({ className: 'seg', title }, ...content).on({ click: () => ui.engine.dispatch(new ExecCommandAction(item.command)) })
    : span({ className: 'seg', title }, ...content);
}

/**
 * The two things that make background work and standing problems discoverable at all.
 *
 * Running work shows only while it is running — a status bar that always carries an
 * "Activity" button teaches people to ignore it. The attention badge is the opposite:
 * it stays until the problem is actually fixed, because that is the whole point of an
 * issue as against a toast that scrolls away.
 */
export function activityChips(state, ui) {
  const act = state.act || { tasks: [], issues: [] };
  const running = act.tasks.filter((t) => t.status === 'running');
  const open = () => ui.engine.dispatch(new ToggleActivityPanelAction(true));
  const chips = [];

  if (running.length) {
    const first = running[0];
    const determinate = first.total != null && first.total > 0;
    const pct = determinate ? Math.round(((first.done || 0) / first.total) * 100) : null;
    chips.push(button({
      className: 'seg sb-activity',
      title: running.map((t) => t.title).join('\n'),
    },
    div({ className: 'spinner', $styling: { width: '11px', height: '11px' } }),
    span(running.length > 1
      ? `${running.length} running`
      : `${first.title}${pct == null ? '' : ` ${pct}%`}`)).on({ click: open }));
  }

  if (act.issues.length) {
    chips.push(button({
      className: 'seg sb-attention',
      title: act.issues.map((i) => i.title).join('\n'),
    }, icon('info', { size: 12 }), span(`${act.issues.length} need${act.issues.length === 1 ? 's' : ''} attention`))
      .on({ click: open }));
  }
  return chips;
}

/**
 * How full the disk is — but only when the backend actually knows.
 *
 * A filesystem or NAS can answer exactly, and that is where it matters: a disk fills
 * up and every upload starts failing with no warning that anything was coming. An
 * object store has no equivalent number, so this renders nothing at all rather than a
 * meter that means nothing. The bar turns amber under 10% free and red under 5%, which
 * is early enough to act on.
 */
export function usageChip({ usage: u, usageLevel: level = '' }) {
  if (!u?.total) return null;
  const pct = Math.min(100, Math.round((u.used / u.total) * 100));
  return span({
    className: `seg sb-usage ${level}`,
    title: `${bytes(u.used)} used of ${bytes(u.total)} — ${bytes(u.available)} free on this volume`,
  },
  div({ className: 'usage-bar' }, div({ className: 'usage-fill', $styling: { width: `${pct}%` } })),
  span(`${bytes(u.available)} free`));
}

export default function statusBar(state, ui) {
  const ex = state.ex;
  const items = ex.items || [];
  // Derived by the `statusFacts` query — see bl/status.js. These used to be worked out
  // here and imported INTO the phone chrome from this module, which is a business-layer
  // derivation living in a component and being shared out of it.
  const f = state.facts;
  const { totalItems, totalBytes } = f;
  const caps = state.caps;
  const active = f.uploading;

  // Plugin-contributed status slots. Already filtered and ordered by the query.
  const slots = state.statusItems || [];
  const left = slots.filter((s) => s.slot === 'left').map((s) => statusSlot(s, ui));
  const right = slots.filter((s) => s.slot !== 'left').map((s) => statusSlot(s, ui));

  const off = f.off;
  return div({ className: 'statusbar' },
    !off.online
      ? span({ className: 'seg offline-badge', title: 'You are offline — pinned files and cached data are available' }, icon('info', { size: 12 }), span('Offline'))
      : off.syncing
        ? span({ className: 'seg', title: 'Syncing offline changes' }, div({ className: 'spinner', $styling: { width: '11px', height: '11px' } }), span('Syncing…'))
        : null,
    off.queued ? span({ className: 'seg', title: 'Changes waiting to sync' }, `${off.queued} queued`) : null,
    // The pinned files themselves. There is no offline-files view anywhere, so a chip
    // counting them that only dropped you on the home screen was a label pretending to
    // be a control — and unpinning meant finding each file again through search.
    off.pins.length
      ? button({ className: 'seg', title: `${off.pins.length} file(s) available offline` },
        icon('download', { size: 12 }), span(`${off.pins.length} offline`), icon('chevron-down', { size: 11 }))
        .on({ click: (e) => {
          const items = off.pins.slice(0, 12).flatMap((p) => [
            { label: p.name, icon: 'file-text', actions: [new ExecCommandAction('explorer.open', p)] },
            { label: `Remove “${p.name}” from offline`, icon: 'close', actions: [new ExecCommandAction('offline.unpin', p)] },
            { sep: true },
          ]);
          if (off.pins.length > 12) items.push({ label: `…and ${off.pins.length - 12} more`, actions: [] });
          ui.engine.dispatch(new ShowContextMenuAction(items, {
            rect: e.currentTarget.getBoundingClientRect(), prefer: 'up',
          }));
        } })
      : null,
    button({ className: 'seg', title: 'Switch collection' },
      // The NAME, and nothing invented. `|| 'default'` used to sit here, which meant the
      // status bar cheerfully named a collection on a drive that had none.
      icon('files', { size: 13 }), span(f.collectionLabel),
      (ex.collections || []).length > 1 || ex.canCreateCollection ? icon('chevron-down', { size: 11 }) : null)
      .on({ click: (e) => {
        const items = ex.collectionMenu || [];
        // With nowhere else to go, the segment is a label, not a dead menu.
        if (items.length > 1 || ex.canCreateCollection) {
          ui.engine.dispatch(new ShowContextMenuAction(items, {
            rect: e.currentTarget.getBoundingClientRect(), prefer: 'up',
          }));
        } else ui.engine.dispatch(new ExecCommandAction('workbench.view.home'));
      } }),
    active.length
      ? button({ className: 'seg', title: 'Active uploads — click to cancel' }, div({ className: 'spinner', $styling: { width: '11px', height: '11px' } }), span(`${active.length} uploading`))
        .on({ click: (e) => ui.engine.dispatch(new ShowContextMenuAction(active.map((t) => ({
          label: `Cancel ${t.name} (${Math.round((t.ratio || 0) * 100)}%)`, icon: 'close', danger: true,
          actions: [new CancelTransferAction(t.id)],
        })), { x: e.clientX, y: e.clientY })) })
      : span({ className: 'seg', title: ex.nextCursor ? `Showing ${items.length} of ${f.totalKnown ? totalItems : 'more'}` : '' },
        `${totalItems.toLocaleString()}${f.totalKnown || !f.partial ? '' : '+'} item${totalItems === 1 ? '' : 's'}`),
    ...left,
    div({ className: 'spacer' }),
    ...activityChips(state, ui),
    ...right,
    // Same qualifier as the item count beside it. Without it the two numbers in one bar
    // disagreed about their own honesty: "500+ items" next to a byte figure that was
    // only the loaded page's, presented as the collection's.
    span({
      className: 'seg',
      title: f.totalKnown || !f.partial
        ? 'Total size of this collection'
        : `Size of the ${f.shown.toLocaleString()} items loaded so far — this server doesn’t report a collection total`,
    }, `${bytes(totalBytes)}${f.totalKnown || !f.partial ? '' : '+'}`),
    usageChip(f),
    caps ? span({ className: 'seg', title: 'Storage backend capabilities' },
      icon(caps.storage?.presignDownload ? 'download' : 'files', { size: 12 }),
      span(caps.storage?.presignDownload ? 'S3 direct' : 'proxied'),
    ) : null,
    caps?.features?.semanticSearch ? button({ className: 'seg', title: 'Semantic search enabled' }, icon('star', { size: 12 }), span('semantic'))
      .on({ click: () => ui.engine.dispatch(new ExecCommandAction('workbench.view.home')) }) : null,
  );
}
