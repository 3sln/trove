// Small transient overlays: modal dialog (prompt/confirm), right-click context
// menu, toast notifications, the upload/transfer tray, and the plugin popup
// panel (which hosts a plugin's own iframe, Chrome-extension style).

import { dd } from '../../runtime.js';
import { icon, iconForNode } from '../icon.js';
import { bytes } from '../format.js';
import { pluginReview } from './pluginReview.js';
import { typeKeyFor, typeLabelFor, rememberOpener, openerSource } from '../../bl/openers.js';

const { div, span, button, input, h3, p, select, option, label, textarea } = dd;

// ---- Dialog ----------------------------------------------------------------
export function dialog(state, ui) {
  const d = state.overlay.dialog;
  if (!d) return null;
  if (d.kind === 'collection') return collectionDialog(d, ui);
  if (d.kind === 'plugin-review') return pluginReview(d, ui);
  if (d.kind === 'opener-chooser') return openerChooserDialog(d, ui);
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

// Choose which viewer opens a file when several openers match. Reactive via the
// workbench dialog state (updateDialog), so radio/checkbox selection survives
// re-renders. "Remember" persists a per-file-type association in settings.
function openerChooserDialog(d, ui) {
  const wb = ui.platform.workbench;
  const platform = ui.platform;
  const selected = d.openerId || d.current || d.openers[0]?.id;
  const remember = !!d.remember;
  const confirm = () => {
    if (remember && selected) rememberOpener(platform, typeKeyFor(d.node), selected);
    wb.closeDialog();
    wb.openFile(d.node, selected, { reset: !!d.reset });
  };
  return div({},
    div({ className: 'scrim' }).on({ click: () => wb.closeDialog() }),
    div({ className: 'dialog opener-chooser' },
      h3(`Open “${d.node.name}” with…`),
      div({ className: 'opener-list' },
        ...d.openers.map((o) =>
          label({ className: `opener-opt ${o.id === selected ? 'sel' : ''}` },
            input({ type: 'radio', name: 'opener-choice', checked: o.id === selected })
              .on({ change: () => wb.updateDialog({ openerId: o.id }) }),
            icon(o.icon || iconForNode(d.node), { size: 18 }),
            div({ className: 'oo-main' },
              span({ className: 'oo-title' }, o.title || o.id),
              span({ className: 'oo-src' }, openerSource(platform, o)),
            ),
          ).on({ click: () => wb.updateDialog({ openerId: o.id }) }),
        ),
      ),
      label({ className: 'opener-remember' },
        input({ type: 'checkbox', checked: remember }).on({ change: (e) => wb.updateDialog({ remember: e.target.checked }) }),
        span(`Always use this for ${typeLabelFor(d.node)}`),
      ),
      div({ className: 'row-actions' },
        button({ className: 'btn' }, 'Cancel').on({ click: () => wb.closeDialog() }),
        button({ className: 'btn primary' }, 'Open').on({ click: confirm }),
      ),
    ),
  );
}

// A collection is a backing-store config. This form collects the driver + its
// fields (filesystem path, or S3 bucket/prefix/keys) so a user with the create
// capability can provision a new collection dynamically. The form persists
// across re-renders (keyed to the dialog instance) so switching driver keeps it.
let colState = { ref: null, form: null };
function collectionDialog(d, ui) {
  const wb = ui.platform.workbench;
  if (colState.ref !== d) {
    colState = { ref: d, form: { name: '', description: '', driver: 'filesystem', root: '', bucket: '', prefix: '', region: 'auto', endpoint: '', accessKeyId: '', secretAccessKey: '' } };
  }
  const form = colState.form;
  const set = (k) => (e) => { form[k] = e.target.value; if (k === 'driver') ui.rerender?.(); };
  const submit = () => {
    const store = { driver: form.driver };
    if (form.driver === 'filesystem') store.root = form.root;
    if (form.driver === 's3') {
      store.s3 = { bucket: form.bucket, region: form.region, endpoint: form.endpoint || undefined, accessKeyId: form.accessKeyId, secretAccessKey: form.secretAccessKey, forcePathStyle: !!form.endpoint };
      if (form.prefix) store.prefix = form.prefix;
    }
    if (form.driver === 'filesystem' && form.prefix) store.prefix = form.prefix;
    d.onSubmit?.({ name: form.name, description: form.description, store });
  };
  const field = (lbl, k, ph = '') => div({ className: 'field', $styling: { marginBottom: '10px' } },
    label(lbl), input({ className: 'input', placeholder: ph }).on({ input: set(k) }));
  return div({},
    div({ className: 'scrim' }).on({ click: () => wb.closeDialog() }),
    div({ className: 'dialog', $styling: { width: 'min(480px, 94vw)' } },
      h3('New collection'),
      div({ className: 'body' }, 'A collection is a backing store you own. Configure where its files live.'),
      field('Name', 'name', 'Team Vault'),
      div({ className: 'field', $styling: { marginBottom: '10px' } },
        label('Backing store'),
        select({ className: 'input' },
          option({ value: 'filesystem', selected: form.driver === 'filesystem' }, 'Filesystem / NAS'),
          option({ value: 's3', selected: form.driver === 's3' }, 'S3-compatible (S3 · R2 · MinIO)'),
          option({ value: 'memory', selected: form.driver === 'memory' }, 'Memory (ephemeral)'),
        ).on({ change: set('driver') })),
      storeFields(form, set),
      div({ className: 'row-actions' },
        button({ className: 'btn' }, 'Cancel').on({ click: () => wb.closeDialog() }),
        button({ className: 'btn primary' }, 'Create collection').on({ click: submit }),
      ),
    ),
  );
}
function storeFields(form, set) {
  const f = (lbl, k, ph = '', type = 'text') => div({ className: 'field', $styling: { marginBottom: '10px' } },
    label(lbl), input({ className: 'input', placeholder: ph, type, autocomplete: 'off' }).on({ input: set(k) }));
  if (form.driver === 'filesystem') return div({}, f('Root directory', 'root', './data/team'), f('Prefix (optional)', 'prefix'));
  if (form.driver === 's3') {
    return div({},
      f('Bucket', 'bucket', 'my-bucket'),
      f('Prefix (optional)', 'prefix', 'team-a/'),
      f('Region', 'region', 'auto'),
      f('Endpoint (R2/MinIO; blank for AWS)', 'endpoint', 'https://<acct>.r2.cloudflarestorage.com'),
      f('Access key id', 'accessKeyId'),
      f('Secret access key', 'secretAccessKey', '', 'password'),
    );
  }
  return div({ className: 'body', $styling: { fontSize: '12px' } }, 'Ephemeral — data is lost on restart. Good for testing.');
}

// ---- Context menu ----------------------------------------------------------
export function contextMenu(state, ui) {
  const m = state.overlay.contextMenu;
  if (!m || !m.items?.length) return null;
  const wb = ui.platform.workbench;
  // Clamp on both edges. Anchoring a menu ABOVE its trigger (the status bar opens
  // upward) produces a negative top, and only the far edge used to be clamped.
  // The height is whatever the menu needs OR whatever the window allows, whichever is
  // smaller — past that the menu scrolls (see `.menu`), so pushing it further up buys
  // nothing and would just leave a gap at the bottom.
  const wanted = Math.min(m.items.length * 34 + 20, window.innerHeight - 24);
  const x = Math.max(8, Math.min(m.x, window.innerWidth - 220));
  const y = Math.max(8, Math.min(m.y, window.innerHeight - wanted));
  return div({},
    div({ className: 'scrim', $styling: { background: 'transparent' } }).on({ click: () => wb.closeContextMenu(), contextmenu: (e) => { e.preventDefault(); wb.closeContextMenu(); } }),
    div({ className: 'menu', $styling: { left: x + 'px', top: y + 'px' } },
      ...m.items.map((it, i) =>
        it.sep
          ? div({ className: 'sep' })
          // A real <button>, not a click-handling div: menu entries were unreachable by
          // keyboard and invisible to the TV shell's spatial navigation, which only
          // considers focusable elements.
          : button({ className: `mi ${it.danger ? 'danger' : ''}`, autofocus: i === 0 },
              it.icon ? icon(it.icon, { size: 15 }) : null,
              span(it.label),
              it.kbd ? span({ className: 'kbd' }, it.kbd) : null,
            ).on({
              click: () => { wb.closeContextMenu(); it.run?.(); },
              // The first item is focused on open, so Escape has to get you back out.
              keydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); wb.closeContextMenu(); } },
              $attach: (el) => { if (i === 0) queueMicrotask(() => el.focus()); },
            }),
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
  const pid = state.overlay.pluginPanel;
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
