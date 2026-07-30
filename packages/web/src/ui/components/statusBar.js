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
export function activityChips(state, ui) {
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

/**
 * How full the disk is — but only when the backend actually knows.
 *
 * A filesystem or NAS can answer exactly, and that is where it matters: a disk fills
 * up and every upload starts failing with no warning that anything was coming. An
 * object store has no equivalent number, so this renders nothing at all rather than a
 * meter that means nothing. The bar turns amber under 10% free and red under 5%, which
 * is early enough to act on.
 */
export function usageChip(ex) {
  const u = ex.usage;
  if (!u?.total) return null;
  const freeRatio = u.available / u.total;
  const pct = Math.min(100, Math.round((u.used / u.total) * 100));
  const level = freeRatio < 0.05 ? 'critical' : freeRatio < 0.1 ? 'low' : '';
  return span({
    className: `seg sb-usage ${level}`,
    title: `${bytes(u.used)} used of ${bytes(u.total)} — ${bytes(u.available)} free on this volume`,
  },
  div({ className: 'usage-bar' }, div({ className: 'usage-fill', $styling: { width: `${pct}%` } })),
  span(`${bytes(u.available)} free`));
}

/**
 * Everything the status bar reports, derived once.
 *
 * Two shells render these: the desktop as a row of segments along the bottom, the phone
 * as rows in a sheet behind a single icon. Deriving them in one place is what stops the
 * two from quietly telling the user different things about the same drive.
 */
export function statusFacts(state, ui) {
  const ex = state.ex;
  const items = ex.items || [];
  const act = state.act || { tasks: [], issues: [] };
  return {
    // `null` with nothing open — `collectionLabel` renders that as "no collection". The
    // old fallback made the bar name a collection that may not exist, on a drive where
    // the user had not yet chosen one.
    collectionId: ex.collectionId ?? null,
    // What to CALL it, so the phone shell and the desktop bar cannot end up saying
    // different things — which is the entire reason these facts are derived once. The
    // phone rendered `collectionId` raw, which showed an opaque `col_…` id where the
    // desktop showed the name.
    collectionLabel: collectionLabel(ex),
    // The COLLECTION's totals when the server could give them, not the page's. Summing
    // what happens to be loaded reports a 3,000-file drive as 500 files — a wrong number,
    // not a rounded one. Falls back to the page only when the server didn't say.
    totalItems: ex.stats?.items ?? items.length,
    // Whether that total is the COLLECTION's or just the page we happen to hold. With
    // more pages waiting, the page length is a floor, not a total, and must read as one.
    totalKnown: ex.stats?.items != null,
    totalBytes: ex.stats?.bytes ?? items.reduce((n, i) => n + (i.size || 0), 0),
    shown: items.length,
    partial: !!ex.nextCursor,
    usage: ex.usage,
    uploading: state.tr.items.filter((t) => t.status === 'active'),
    running: act.tasks.filter((t) => t.status === 'running'),
    issues: act.issues,
    off: state.off || { online: true, pins: [], queued: 0, syncing: false },
    caps: ui.platform.capabilities,
  };
}

/** What to call the current collection: its name, its id, or an honest nothing. */
function collectionLabel(ex) {
  if (!ex?.collectionId) return 'no collection';
  const match = (ex.collections || []).find((c) => c.id === ex.collectionId);
  return match?.name || ex.collectionId;
}

export default function statusBar(state, ui) {
  const ex = state.ex;
  const items = ex.items || [];
  const f = statusFacts(state, ui);
  const { totalItems, totalBytes, caps } = f;
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
            { label: p.name, icon: 'file-text', run: () => ui.exec('explorer.open', p) },
            { label: `Remove “${p.name}” from offline`, icon: 'close', run: () => ui.exec('offline.unpin', p) },
            { sep: true },
          ]);
          if (off.pins.length > 12) items.push({ label: `…and ${off.pins.length - 12} more`, run: () => {} });
          const r = e.currentTarget.getBoundingClientRect();
          ui.platform.workbench.showContextMenu(r.left, r.top - 8 - items.length * 34, items);
        } })
      : null,
    button({ className: 'seg', title: 'Switch collection' },
      // The NAME, and nothing invented. `|| 'default'` used to sit here, which meant the
      // status bar cheerfully named a collection on a drive that had none.
      icon('files', { size: 13 }), span(collectionLabel(ex)),
      (ex.collections || []).length > 1 || ex.canCreateCollection ? icon('chevron-down', { size: 11 }) : null)
      .on({ click: (e) => {
        const items = ui.app.collectionMenu?.() || [];
        // With nowhere else to go, the segment is a label, not a dead menu.
        if (items.length > 1 || ex.canCreateCollection) {
          const r = e.currentTarget.getBoundingClientRect();
          ui.platform.workbench.showContextMenu(r.left, r.top - 8 - items.length * 34, items);
        } else ui.exec('workbench.view.home');
      } }),
    active.length
      ? button({ className: 'seg', title: 'Active uploads — click to cancel' }, div({ className: 'spinner', $styling: { width: '11px', height: '11px' } }), span(`${active.length} uploading`))
        .on({ click: (e) => ui.platform.workbench.showContextMenu(e.clientX, e.clientY, active.map((t) => ({
          label: `Cancel ${t.name} (${Math.round((t.ratio || 0) * 100)}%)`, icon: 'close', danger: true,
          run: () => ui.app.transfers.cancel(t.id),
        }))) })
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
    usageChip(ex),
    caps ? span({ className: 'seg', title: 'Storage backend capabilities' },
      icon(caps.storage?.presignDownload ? 'download' : 'files', { size: 12 }),
      span(caps.storage?.presignDownload ? 'S3 direct' : 'proxied'),
    ) : null,
    caps?.features?.semanticSearch ? button({ className: 'seg', title: 'Semantic search enabled' }, icon('star', { size: 12 }), span('semantic'))
      .on({ click: () => ui.exec('workbench.view.home') }) : null,
  );
}
