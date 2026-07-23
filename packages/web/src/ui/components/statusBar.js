import { dd } from '../../runtime.js';
import { icon } from '../icon.js';
import { bytes } from '../format.js';

const { div, button, span } = dd;

export default function statusBar(state, ui) {
  const ex = state.ex;
  const items = ex.items || [];
  const folders = items.filter((i) => i.kind === 'folder').length;
  const files = items.length - folders;
  const totalBytes = items.reduce((n, i) => n + (i.kind === 'file' ? i.size || 0 : 0), 0);
  const active = state.tr.items.filter((t) => t.status === 'active');
  const caps = ui.platform.capabilities;

  // Plugin-contributed status items (right side).
  const pluginItems = state.statusItems || [];

  return div({ className: 'statusbar' },
    button({ className: 'seg', title: 'Explorer' }, icon('files', { size: 13 }), span(ex.folder ? ex.folder.path : '/'))
      .on({ click: () => ui.exec('workbench.view.explorer') }),
    active.length
      ? button({ className: 'seg' }, div({ className: 'spinner', $styling: { width: '11px', height: '11px' } }), span(`${active.length} uploading`))
        .on({ click: () => ui.platform.workbench.showContextMenu(0, 0, []) })
      : span({ className: 'seg' }, `${files} files · ${folders} folders`),
    div({ className: 'spacer' }),
    ...pluginItems.filter((s) => s.align !== 'left').map((s) =>
      button({ className: 'seg', title: s.tooltip || '' }, s.text || '')
        .on({ click: () => s.command && ui.exec(s.command) }),
    ),
    span({ className: 'seg', title: 'Total size of this folder' }, bytes(totalBytes)),
    caps ? span({ className: 'seg', title: 'Storage backend capabilities' },
      icon(caps.storage?.presignDownload ? 'download' : 'files', { size: 12 }),
      span(caps.storage?.presignDownload ? 'S3 direct' : 'proxied'),
    ) : null,
    caps?.features?.semanticSearch ? button({ className: 'seg', title: 'Semantic search enabled' }, icon('star', { size: 12 }), span('semantic'))
      .on({ click: () => ui.exec('workbench.view.search') }) : null,
  );
}
