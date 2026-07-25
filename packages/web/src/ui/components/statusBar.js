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

export default function statusBar(state, ui) {
  const ex = state.ex;
  const items = ex.items || [];
  const folders = items.filter((i) => i.kind === 'folder').length;
  const files = items.length - folders;
  const totalBytes = items.reduce((n, i) => n + (i.kind === 'file' ? i.size || 0 : 0), 0);
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
    button({ className: 'seg', title: 'Explorer' }, icon('files', { size: 13 }), span(ex.folder ? ex.folder.path : '/'))
      .on({ click: () => ui.exec('workbench.view.home') }),
    active.length
      ? button({ className: 'seg', title: 'Active uploads — click to cancel' }, div({ className: 'spinner', $styling: { width: '11px', height: '11px' } }), span(`${active.length} uploading`))
        .on({ click: (e) => ui.platform.workbench.showContextMenu(e.clientX, e.clientY, active.map((t) => ({
          label: `Cancel ${t.name} (${Math.round((t.ratio || 0) * 100)}%)`, icon: 'close', danger: true,
          run: () => ui.app.transfers.cancel(t.id),
        }))) })
      : span({ className: 'seg' }, `${files} files · ${folders} folders`),
    ...left,
    div({ className: 'spacer' }),
    ...right,
    span({ className: 'seg', title: 'Total size of this folder' }, bytes(totalBytes)),
    caps ? span({ className: 'seg', title: 'Storage backend capabilities' },
      icon(caps.storage?.presignDownload ? 'download' : 'files', { size: 12 }),
      span(caps.storage?.presignDownload ? 'S3 direct' : 'proxied'),
    ) : null,
    caps?.features?.semanticSearch ? button({ className: 'seg', title: 'Semantic search enabled' }, icon('star', { size: 12 }), span('semantic'))
      .on({ click: () => ui.exec('workbench.view.home') }) : null,
  );
}
