import { dd } from '../../runtime.js';
import { icon } from '../icon.js';
import { bytes } from '../format.js';
import { sanitizedVNodes, htmlToText } from '../sanitize.js';

const { div, button, span } = dd;

/**
 * A plugin's status slot. The manifest declares the slot (name + side); the plugin
 * pushes content into it at runtime over RPC. The content is untrusted HTML from a
 * sandboxed frame, so it goes through the allowlist sanitizer before it becomes nodes.
 * A slot with nothing in it, or one whose `when` doesn't hold, renders nothing at all
 * rather than an empty chip.
 */
function statusSlot(item, ui) {
  if (item.visible === false || !item.html) return null;
  if (item.when && !ui.platform.context.evaluate(item.when)) return null;
  if (!ui.platform.plugins.isAvailable(item)) return null;
  const content = sanitizedVNodes(item.html, dd);
  if (!content.length) return null;
  const title = item.tooltip ? htmlToText(item.tooltip) : '';
  return item.command
    ? button({ className: 'seg', title }, ...content).on({ click: () => ui.exec(item.command) })
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
function activityChips(state, ui) {
  const act = state.act || { tasks: [], issues: [] };
  const running = act.tasks.filter((t) => t.status === 'running');
  const open = () => ui.app.activity.togglePanel(true);
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

export default function statusBar(state, ui) {
  const ex = state.ex;
  const items = ex.items || [];
  // The COLLECTION's totals when the server could give them, not the page's. Summing
  // what happens to be loaded reports a 3,000-file drive as 500 files — a wrong number,
  // not a rounded one. Falls back to the page only when the server didn't say.
  const totalItems = ex.stats?.items ?? items.length;
  const totalBytes = ex.stats?.bytes ?? items.reduce((n, i) => n + (i.size || 0), 0);
  const active = state.tr.items.filter((t) => t.status === 'active');
  const caps = ui.platform.capabilities;

  // Plugin-contributed status slots, ordered by their declared `order` then name.
  const slots = [...(state.statusItems || [])]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  const left = slots.filter((s) => s.slot === 'left').map((s) => statusSlot(s, ui));
  const right = slots.filter((s) => s.slot !== 'left').map((s) => statusSlot(s, ui));

  const off = state.off || { online: true, pins: [], queued: 0, syncing: false };
  return div({ className: 'statusbar' },
    !off.online
      ? span({ className: 'seg offline-badge', title: 'You are offline — pinned files and cached data are available' }, icon('info', { size: 12 }), span('Offline'))
      : off.syncing
        ? span({ className: 'seg', title: 'Syncing offline changes' }, div({ className: 'spinner', $styling: { width: '11px', height: '11px' } }), span('Syncing…'))
        : null,
    off.queued ? span({ className: 'seg', title: 'Changes waiting to sync' }, `${off.queued} queued`) : null,
    off.pins.length ? button({ className: 'seg', title: `${off.pins.length} file(s) available offline` }, icon('download', { size: 12 }), span(`${off.pins.length} offline`)).on({ click: () => ui.exec('workbench.view.home') }) : null,
    button({ className: 'seg', title: 'Collection' }, icon('files', { size: 13 }), span(ex.collectionId || 'default'))
      .on({ click: () => ui.exec('workbench.view.home') }),
    active.length
      ? button({ className: 'seg', title: 'Active uploads — click to cancel' }, div({ className: 'spinner', $styling: { width: '11px', height: '11px' } }), span(`${active.length} uploading`))
        .on({ click: (e) => ui.platform.workbench.showContextMenu(e.clientX, e.clientY, active.map((t) => ({
          label: `Cancel ${t.name} (${Math.round((t.ratio || 0) * 100)}%)`, icon: 'close', danger: true,
          run: () => ui.app.transfers.cancel(t.id),
        }))) })
      : span({ className: 'seg', title: ex.nextCursor ? `Showing ${items.length} of ${totalItems}` : '' },
        `${totalItems.toLocaleString()} item${totalItems === 1 ? '' : 's'}`),
    ...left,
    div({ className: 'spacer' }),
    ...activityChips(state, ui),
    ...right,
    span({ className: 'seg', title: 'Total size of this collection' }, bytes(totalBytes)),
    caps ? span({ className: 'seg', title: 'Storage backend capabilities' },
      icon(caps.storage?.presignDownload ? 'download' : 'files', { size: 12 }),
      span(caps.storage?.presignDownload ? 'S3 direct' : 'proxied'),
    ) : null,
    caps?.features?.semanticSearch ? button({ className: 'seg', title: 'Semantic search enabled' }, icon('star', { size: 12 }), span('semantic'))
      .on({ click: () => ui.exec('workbench.view.home') }) : null,
  );
}
