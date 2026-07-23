import { dd } from '../../runtime.js';
import { icon, iconForNode } from '../icon.js';
import { bytes, relativeDate } from '../format.js';
import { NavigateAction, OpenFileAction, MoveAction } from '../../bl/actions.js';

const { div, button, span } = dd;

export default function explorer(state, ui) {
  const ex = state.ex;
  return div({ className: 'sidebar' },
    header(ex, ui),
    (ex.collections && ex.collections.length > 1) || ex.canCreateCollection ? collectionBar(ex, ui) : null,
    breadcrumb(ex, ui),
    div({ className: 'scroll' }, body(ex, ui)),
  );
}

function collectionBar(ex, ui) {
  const active = ex.collections.find((c) => c.id === ex.collectionId) || { name: 'My Drive', id: 'default' };
  return button({ className: 'collection-switch' },
    icon('files', { size: 14 }),
    span({ className: 'cs-name' }, active.name),
    icon('chevron-down', { size: 13 }),
  ).on({
    click: (e) => {
      const items = ex.collections.map((c) => ({
        label: c.name, icon: c.id === ex.collectionId ? 'check' : 'files',
        run: () => ui.exec('collections.switch', c.id),
      }));
      if (ex.canCreateCollection) {
        items.push({ sep: true });
        items.push({ label: 'New collection…', icon: 'plus', run: () => ui.exec('collections.create') });
      }
      const r = e.currentTarget.getBoundingClientRect();
      ui.platform.workbench.showContextMenu(r.left, r.bottom + 4, items);
    },
  });
}

function header(ex, ui) {
  return div({ className: 'head' },
    span('Explorer'),
    div({ className: 'actions' },
      iconBtn('new-folder', 'New folder', () => ui.exec('explorer.newFolder'), ui),
      iconBtn('upload', 'Upload files', () => ui.exec('explorer.upload'), ui),
      iconBtn('refresh', 'Refresh', () => ui.exec('explorer.refresh'), ui),
    ),
  );
}

function breadcrumb(ex, ui) {
  const trail = ex.breadcrumb.length ? ex.breadcrumb : [{ id: 'root', name: 'Home', path: '/' }];
  return div({ className: 'breadcrumb' },
    ...trail.flatMap((c, i) => {
      const label = c.path === '/' ? 'Home' : c.name;
      const crumb = button({ className: `crumb ${i === trail.length - 1 ? 'current' : ''}` }, label)
        .on({ click: () => ui.go(new NavigateAction(c.id)) });
      return i < trail.length - 1 ? [crumb, span({ className: 'sep' }, icon('chevron-right', { size: 13 }))] : [crumb];
    }),
  );
}

function body(ex, ui) {
  if (ex.loading && !ex.items.length) {
    return div({ className: 'empty' }, div({ className: 'spinner' }), span('Loading…'));
  }
  if (ex.error) {
    return div({ className: 'empty' }, icon('warn', { size: 30 }), span(ex.error),
      button({ className: 'cta' }, 'Retry').on({ click: () => ui.exec('explorer.refresh') }));
  }
  if (!ex.items.length) {
    return div({ className: 'empty' },
      div({ className: 'big' }, icon('folder-open', { size: 40 })),
      span('This folder is empty'),
      button({ className: 'cta' }, 'Upload files').on({ click: () => ui.exec('explorer.upload') }),
    );
  }
  return div({ className: 'filelist' }, ...ex.items.map((node) => row(node, ex, ui)));
}

function row(node, ex, ui) {
  const selected = ex.selection.includes(node.id);
  const ic = iconForNode(node);
  return div({
    className: `row ${selected ? 'selected' : ''}`,
    $attrs: { draggable: 'true', 'data-id': node.id },
  },
    span({ className: `ico ${node.kind === 'folder' ? 'folder' : ''}` }, icon(ic, { size: 17 })),
    span({ className: 'name' }, node.name),
    span({ className: 'meta' }, node.kind === 'file' ? bytes(node.size) : relativeDate(node.updatedAt)),
  ).on({
    click: (e) => {
      if (e.metaKey || e.ctrlKey) ui.app.explorer.toggleSelect(node.id);
      else ui.app.explorer.select([node.id]);
      ui.platform.context.set('explorer.hasSelection', ui.app.explorer.state.selection.length > 0);
    },
    dblclick: () => ui.go(new OpenFileAction(node)),
    contextmenu: (e) => {
      e.preventDefault();
      if (!ex.selection.includes(node.id)) ui.app.explorer.select([node.id]);
      openRowMenu(e, node, ui);
    },
    dragstart: (e) => {
      const ids = ex.selection.includes(node.id) ? ex.selection : [node.id];
      e.dataTransfer.setData('application/x-trove-ids', JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'move';
    },
    dragover: (e) => {
      if (node.kind === 'folder' && e.dataTransfer.types.includes('application/x-trove-ids')) {
        e.preventDefault();
        e.currentTarget.classList.add('drop-target');
      }
    },
    dragleave: (e) => e.currentTarget.classList.remove('drop-target'),
    drop: (e) => {
      e.currentTarget.classList.remove('drop-target');
      const raw = e.dataTransfer.getData('application/x-trove-ids');
      if (node.kind === 'folder' && raw) {
        e.preventDefault();
        const ids = JSON.parse(raw).filter((id) => id !== node.id);
        if (ids.length) ui.go(new MoveAction(ids, node.id));
      }
    },
  });
}

function openRowMenu(e, node, ui) {
  const items = [
    { label: 'Open', icon: 'file', run: () => ui.go(new OpenFileAction(node)) },
    node.kind === 'file' && { label: 'Download', icon: 'download', run: () => ui.exec('explorer.download', node) },
    { sep: true },
    { label: 'Rename…', icon: 'file-text', run: () => ui.exec('explorer.rename') },
    { label: 'Delete', icon: 'trash', danger: true, run: () => ui.exec('explorer.delete') },
  ].filter(Boolean);
  ui.platform.workbench.showContextMenu(e.clientX, e.clientY, items);
}

function iconBtn(name, title, onClick, ui) {
  return button({ className: 'iconbtn', title }, icon(name, { size: 15 })).on({ click: onClick });
}
