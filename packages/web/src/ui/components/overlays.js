// Small transient overlays: modal dialog (prompt/confirm), right-click context
// menu, toast notifications, the upload/transfer tray, and the plugin popup
// panel (which hosts a plugin's own iframe, Chrome-extension style).

import { dd } from '../../runtime.js';
import { icon } from '../icon.js';
import { bytes } from '../format.js';

const { div, span, button, input, h3, p } = dd;

// ---- Dialog ----------------------------------------------------------------
export function dialog(state, ui) {
  const d = state.wb.dialog;
  if (!d) return null;
  const wb = ui.platform.workbench;
  let value = d.value ?? '';
  const submit = () => (d.kind === 'confirm' ? d.onConfirm?.() : d.onSubmit?.(value));
  return div({},
    div({ className: 'scrim' }).on({ click: () => wb.closeDialog() }),
    div({ className: 'dialog' },
      h3(d.title),
      d.body ? div({ className: 'body' }, d.body) : null,
      d.kind === 'prompt'
        ? div({ className: 'field' },
            d.label ? span({ $styling: { fontSize: '12px', color: 'var(--text-dim)' } }, d.label) : null,
            input({ className: 'input', value: d.value ?? '', placeholder: d.placeholder || '', autofocus: true })
              .on({
                input: (e) => { value = e.target.value; },
                keydown: (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') wb.closeDialog(); },
                $attach: (el) => queueMicrotask(() => { el.focus(); el.select(); }),
              }),
          )
        : null,
      div({ className: 'row-actions' },
        button({ className: 'btn' }, 'Cancel').on({ click: () => wb.closeDialog() }),
        button({ className: `btn ${d.danger ? 'danger' : 'primary'}` }, d.confirmLabel || 'OK').on({ click: submit }),
      ),
    ),
  );
}

// ---- Context menu ----------------------------------------------------------
export function contextMenu(state, ui) {
  const m = state.wb.contextMenu;
  if (!m || !m.items?.length) return null;
  const wb = ui.platform.workbench;
  const x = Math.min(m.x, window.innerWidth - 220);
  const y = Math.min(m.y, window.innerHeight - m.items.length * 34 - 20);
  return div({},
    div({ className: 'scrim', $styling: { background: 'transparent' } }).on({ click: () => wb.closeContextMenu(), contextmenu: (e) => { e.preventDefault(); wb.closeContextMenu(); } }),
    div({ className: 'menu', $styling: { left: x + 'px', top: y + 'px' } },
      ...m.items.map((it) =>
        it.sep
          ? div({ className: 'sep' })
          : div({ className: `mi ${it.danger ? 'danger' : ''}` },
              it.icon ? icon(it.icon, { size: 15 }) : null,
              span(it.label),
              it.kbd ? span({ className: 'kbd' }, it.kbd) : null,
            ).on({ click: () => { wb.closeContextMenu(); it.run?.(); } }),
      ),
    ),
  );
}

// ---- Toasts ----------------------------------------------------------------
export function toasts(state, ui) {
  const list = state.notif || [];
  if (!list.length) return null;
  return div({ className: 'toasts' },
    ...list.slice(-5).map((n) =>
      div({ className: `toast ${n.level}` },
        div({ className: 'bar' }),
        div({ className: 'msg' }, n.message),
        button({ className: 'x' }, icon('close', { size: 14 })).on({ click: () => ui.platform.notifications.dismiss(n.id) }),
      ).key(n.id),
    ),
  );
}

// ---- Transfer tray ---------------------------------------------------------
export function transferTray(state, ui) {
  const items = state.tr.items;
  if (!items.length) return null;
  return div({ className: 'tray' },
    div({ className: 'head' },
      icon('upload', { size: 14 }),
      span({ $styling: { marginLeft: '6px' } }, 'Transfers'),
      div({ className: 'actions' },
        button({ className: 'iconbtn', title: 'Clear finished' }, icon('check', { size: 14 }))
          .on({ click: () => ui.app.transfers.clearDone() }),
      ),
    ),
    div({ className: 'items' },
      ...items.map((t) =>
        div({ className: `xfer ${t.status}` },
          div({ className: 'top' },
            icon(t.status === 'error' ? 'warn' : t.status === 'done' ? 'check' : 'upload', { size: 14 }),
            span({ className: 'name' }, t.name),
            t.status === 'active'
              ? button({ className: 'iconbtn', title: 'Cancel' }, icon('close', { size: 13 })).on({ click: () => ui.app.transfers.cancel(t.id) })
              : span({ className: 'pct' }, t.status === 'done' ? bytes(t.total) : t.status),
          ),
          t.status === 'active'
            ? div({ className: 'progress' }, div({ $styling: { width: `${Math.round(t.ratio * 100)}%` } }))
            : t.error ? div({ $styling: { fontSize: '11px', color: 'var(--danger)', marginTop: '4px' } }, t.error) : null,
          t.status === 'active' ? div({ className: 'pct', $styling: { marginTop: '4px' } }, `${bytes(t.loaded)} / ${bytes(t.total)}`) : null,
        ).key(t.id),
      ),
    ),
  );
}

// ---- Plugin popup panel ----------------------------------------------------
export function pluginPanel(state, ui) {
  const pid = state.wb.pluginPanel;
  if (!pid) return null;
  const plugin = (state.plugins || []).find((p) => p.id === pid);
  return div({ className: 'plugin-panel', $styling: { width: '380px' } },
    div({ className: 'head' },
      icon('plug', { size: 14 }),
      span(plugin?.name || pid),
      button({ className: 'iconbtn x' }, icon('close', { size: 14 })).on({ click: () => ui.platform.workbench.closePluginPanel() }),
    ),
    // The host mounts the plugin's iframe into this element on attach.
    div({ className: 'host' }).on({
      $attach: (el) => {
        el._detach = ui.platform.plugins.mountPanel(pid, el, { width: 380, height: 460 });
      },
      $detach: (el) => el._detach?.(),
    }),
  );
}
