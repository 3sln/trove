// Small transient overlays: modal dialog (prompt/confirm), right-click context
// menu, toast notifications, the upload/transfer tray, and the plugin popup
// panel (which hosts a plugin's own iframe, Chrome-extension style).

import { dd } from '../../runtime.js';
import { icon, iconForNode } from '../icon.js';
import { bytes } from '../format.js';
import { pluginReview } from './pluginReview.js';
import { typeKeyFor, typeLabelFor, rememberOpener, openerSource } from '../../bl/openers.js';
import { draftFor, promptValueOf, PROMPT } from '../../bl/viewState.js';
import { CancelTransferAction, ClearFinishedTransfersAction, CloseContextMenuAction, CloseDialogAction, ClosePluginPanelAction, CreateCollectionFromFormAction, DismissNotificationAction, DismissTransferAction, OpenInPanelAction, RetryTransferAction, SetViewStateAction, UpdateDialogAction } from '../../bl/actions.js';
import { activate } from '../activate.js';

const { div, span, button, input, h3, p, select, option, label, textarea } = dd;

// ---- Dialog ----------------------------------------------------------------
export function dialog(state, ui) {
  const d = state.overlay.dialog;
  if (!d) return null;
  if (d.kind === 'collection') return collectionDialog(d, ui, state.caps, state.view);
  if (d.kind === 'plugin-review') return pluginReview(d, ui, state.view);
  if (d.kind === 'opener-chooser') return openerChooserDialog(d, ui);
  // Both kinds carry ACTIONS — what happens if you say yes — rather than a callback. A
  // prompt's typed value is engine state (see bl/viewState.js), so its actions read what
  // was typed instead of being handed it, and the dialog spec holds no functions.
  //
  // A confirm closes itself here; a prompt's action closes first and then acts, because it
  // has to read the value before the dialog goes.
  const value = promptValueOf(state.view, d);
  const submit = () => {
    if (d.kind === 'confirm') ui.engine.dispatch(new CloseDialogAction());
    activate(ui, { actions: d.confirmActions });
  };
  return div({},
    div({ className: 'scrim' }).on({ click: () => ui.engine.dispatch(new CloseDialogAction()) }),
    div({ className: 'dialog' },
      h3(d.title),
      d.body ? div({ className: 'body' }, d.body) : null,
      d.kind === 'prompt'
        ? div({ className: 'field' },
            d.label ? span({ $styling: { 'font-size': '12px', color: 'var(--text-dim)' } }, d.label) : null,
            input({ className: 'input', value, placeholder: d.placeholder || '', autofocus: true })
              .on({
                input: (e) => ui.engine.dispatch(new SetViewStateAction(PROMPT, { ref: d, value: e.target.value })),
                keydown: (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') ui.engine.dispatch(new CloseDialogAction()); },
                $attach: (el) => queueMicrotask(() => { el.focus(); el.select(); }),
              }),
          )
        : null,
      div({ className: 'row-actions' },
        button({ className: 'btn' }, 'Cancel').on({ click: () => ui.engine.dispatch(new CloseDialogAction()) }),
        button({ className: `btn ${d.danger ? 'danger' : 'primary'}` }, d.confirmLabel || 'OK').on({ click: submit }),
      ),
    ),
  );
}

// Choose which viewer opens a file when several openers match. Reactive via the
// workbench dialog state (updateDialog), so radio/checkbox selection survives
// re-renders. "Remember" persists a per-file-type association in settings.
function openerChooserDialog(d, ui) {
  const platform = ui.platform;
  const selected = d.openerId || d.current || d.openers[0]?.id;
  const remember = !!d.remember;
  const confirm = () => {
    if (remember && selected) rememberOpener(platform, typeKeyFor(d.node), selected);
    ui.engine.dispatch(new CloseDialogAction());
    ui.engine.dispatch(new OpenInPanelAction(d.node, selected, { reset: !!d.reset }));
  };
  return div({},
    div({ className: 'scrim' }).on({ click: () => ui.engine.dispatch(new CloseDialogAction()) }),
    div({ className: 'dialog opener-chooser' },
      h3(`Open “${d.node.name}” with…`),
      div({ className: 'opener-list' },
        ...d.openers.map((o) =>
          label({ className: `opener-opt ${o.id === selected ? 'sel' : ''}` },
            input({ type: 'radio', name: 'opener-choice', checked: o.id === selected })
              .on({ change: () => ui.engine.dispatch(new UpdateDialogAction({ openerId: o.id })) }),
            icon(o.icon || iconForNode(d.node), { size: 18 }),
            div({ className: 'oo-main' },
              span({ className: 'oo-title' }, o.title || o.id),
              span({ className: 'oo-src' }, openerSource(platform, o)),
            ),
          ).on({ click: () => ui.engine.dispatch(new UpdateDialogAction({ openerId: o.id })) }),
        ),
      ),
      label({ className: 'opener-remember' },
        input({ type: 'checkbox', checked: remember }).on({ change: (e) => ui.engine.dispatch(new UpdateDialogAction({ remember: e.target.checked })) }),
        span(`Always use this for ${typeLabelFor(d.node)}`),
      ),
      div({ className: 'row-actions' },
        button({ className: 'btn' }, 'Cancel').on({ click: () => ui.engine.dispatch(new CloseDialogAction()) }),
        button({ className: 'btn primary' }, 'Open').on({ click: confirm }),
      ),
    ),
  );
}

// A collection is a backing-store config, and which stores exist is the SERVER's answer.
//
// This form used to hardcode its own list — Filesystem / NAS, S3, Memory — and the fields
// for each. On Cloudflare Workers that offered a filesystem the runtime cannot provide, so
// the form could produce a collection the server would refuse to build. Now the drivers and
// their fields come from /api/capabilities, which reports what was actually registered.
//
// The form persists across re-renders (keyed to the dialog instance) so switching driver
// keeps what has been typed.
// The collection dialog's unsubmitted form. Engine state, because changing the storage
// driver changes which fields are on screen — see bl/viewState.js.
const COL_FORM = 'collectionDialog';
function collectionDialog(d, ui, caps, view) {
  const drivers = caps?.storageDrivers || [];

  // Derived, not written. This used to install the empty form during the render that
  // noticed the dialog had changed — a render with a side effect. `draftFor` answers with
  // the default when the held draft belongs to a different dialog instance, so nothing is
  // written until the user types something.
  const colState = draftFor(view, COL_FORM, d, {
    form: { name: '', description: '', driver: drivers[0]?.key || '' },
  });
  const form = colState.form;
  const driver = drivers.find((x) => x.key === form.driver) || drivers[0];
  // Every field writes through the cell. Only the driver changes which fields are on
  // screen, but writing them all the same way means there is no second rule to remember —
  // and a text field that only mattered on submit was the reason `form` could be mutated
  // in place at all.
  const set = (k) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    ui.engine.dispatch(new SetViewStateAction(COL_FORM, { ref: colState.ref, form: { ...form, [k]: value } }));
  };

  const submit = () => {
    // Only the fields this driver declared, so a leftover value from a driver the user
    // switched away from is not smuggled into the store config.
    const store = { driver: form.driver };
    for (const f of driver?.fields || []) {
      const v = form[f.name];
      if (v !== undefined && v !== '') store[f.name] = f.type === 'number' ? Number(v) : v;
    }
    ui.engine.dispatch(new CreateCollectionFromFormAction({ name: form.name, description: form.description, store }));
  };

  const field = (lbl, k, ph = '') => div({ className: 'field', $styling: { 'margin-bottom': '10px' } },
    label(lbl), input({ className: 'input', placeholder: ph }).on({ input: set(k) }));

  const ready = !!form.name.trim() && !!form.driver
    && (driver?.fields || []).every((f) => !f.required || String(form[f.name] ?? '').trim());

  return div({},
    div({ className: 'scrim' }).on({ click: () => ui.engine.dispatch(new CloseDialogAction()) }),
    div({ className: 'dialog', $styling: { width: 'min(480px, 94vw)' } },
      h3('New collection'),
      div({ className: 'body' }, 'A collection is a backing store you own. Configure where its files live.'),
      field('Name', 'name', 'Team Vault'),
      drivers.length
        ? div({ className: 'field', $styling: { 'margin-bottom': '10px' } },
          label('Backing store'),
          select({ className: 'input' },
            ...drivers.map((x) => option({ value: x.key, selected: form.driver === x.key }, x.label)),
          ).on({ change: set('driver') }))
        // No drivers at all means the deployment registered none, which is a server
        // misconfiguration — saying so beats an empty dropdown.
        : div({ className: 'body' }, 'This server has no storage drivers registered, so a collection cannot be created.'),
      driver ? storeFields(driver, form, set) : null,
      div({ className: 'row-actions' },
        button({ className: 'btn' }, 'Cancel').on({ click: () => ui.engine.dispatch(new CloseDialogAction()) }),
        button({ className: 'btn primary', $attrs: ready ? {} : { disabled: 'true' } }, 'Create collection')
          .on({ click: () => ready && submit() }),
      ),
    ),
  );
}

/** The chosen driver's declared fields, rendered from its descriptor. */
function storeFields(driver, form, set) {
  if (!driver.fields.length) {
    return div({ className: 'body', $styling: { 'font-size': '12px' } },
      driver.description || 'This store needs no configuration.');
  }
  return div({},
    driver.description
      ? div({ className: 'body', $styling: { 'font-size': '12px', 'margin-bottom': '10px' } }, driver.description)
      : null,
    ...driver.fields.map((f) => (f.type === 'boolean'
      ? div({ className: 'field', $styling: { 'margin-bottom': '10px' } },
        label({}, input({ type: 'checkbox' }).on({ change: set(f.name) }), ` ${f.label}`),
        f.help ? div({ className: 'body', $styling: { 'font-size': '11.5px' } }, f.help) : null)
      : div({ className: 'field', $styling: { 'margin-bottom': '10px' } },
        label(f.label + (f.required ? '' : ' (optional)')),
        input({
          className: 'input', placeholder: f.placeholder, autocomplete: 'off',
          // A field the driver marked secret is a password field, so a shoulder or a
          // screen share does not read an access key out of the form.
          type: f.type === 'password' || f.secret ? 'password' : (f.type === 'number' ? 'number' : 'text'),
        }).on({ input: set(f.name) }),
        f.help ? div({ className: 'body', $styling: { 'font-size': '11.5px' } }, f.help) : null))),
  );
}

// ---- Context menu ----------------------------------------------------------
export function contextMenu(state, ui) {
  const m = state.overlay.contextMenu;
  if (!m || !m.items?.length) return null;
  // Clamp on both edges. Anchoring a menu ABOVE its trigger (the status bar opens
  // upward) produces a negative top, and only the far edge used to be clamped.
  // The height is whatever the menu needs OR whatever the window allows, whichever is
  // smaller — past that the menu scrolls (see `.menu`), so pushing it further up buys
  // nothing and would just leave a gap at the bottom.
  const wanted = Math.min(m.items.length * 34 + 20, window.innerHeight - 24);
  const x = Math.max(8, Math.min(m.x, window.innerWidth - 220));
  const y = Math.max(8, Math.min(m.y, window.innerHeight - wanted));
  return div({},
    div({ className: 'scrim', $styling: { background: 'transparent' } }).on({ click: () => ui.engine.dispatch(new CloseContextMenuAction()), contextmenu: (e) => { e.preventDefault(); ui.engine.dispatch(new CloseContextMenuAction()); } }),
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
              click: () => { ui.engine.dispatch(new CloseContextMenuAction()); activate(ui, it); },
              // The first item is focused on open, so Escape has to get you back out.
              keydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); ui.engine.dispatch(new CloseContextMenuAction()); } },
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
        button({ className: 'x' }, icon('close', { size: 14 })).on({ click: () => ui.engine.dispatch(new DismissNotificationAction(n.id)) }),
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
      span({ $styling: { 'margin-left': '6px' } }, 'Transfers'),
      div({ className: 'actions' },
        button({ className: 'iconbtn', title: 'Clear finished' }, icon('check', { size: 14 }))
          .on({ click: () => ui.engine.dispatch(new ClearFinishedTransfersAction()) }),
      ),
    ),
    div({ className: 'items' },
      ...items.map((t) =>
        div({ className: `xfer ${t.status}` },
          div({ className: 'top' },
            icon(t.status === 'error' ? 'warn' : t.status === 'done' ? 'check' : 'upload', { size: 14 }),
            span({ className: 'name' }, t.name),
            t.status === 'active'
              ? button({ className: 'iconbtn', title: 'Cancel' }, icon('close', { size: 13 })).on({ click: () => ui.engine.dispatch(new CancelTransferAction(t.id)) })
              : span({ className: 'pct' }, t.status === 'done' ? bytes(t.total) : t.status),
          ),
          t.status === 'active'
            ? div({ className: 'progress' }, div({ $styling: { width: `${Math.round(t.ratio * 100)}%` } }))
            : t.error ? div({ $styling: { 'font-size': '11px', color: 'var(--danger)', 'margin-top': '4px' } }, t.error) : null,
          t.status === 'active' ? div({ className: 'pct', $styling: { 'margin-top': '4px' } }, `${bytes(t.loaded)} / ${bytes(t.total)}`) : null,
          // Offered on anything that stopped short, cancelled included — the transport
          // already retries what is worth retrying on its own, so a row that reached this
          // state failed for a reason another automatic attempt would not fix. A lost
          // upload session is the case in point: correctly non-retryable, and correctly
          // something the user can choose to start over.
          (t.status === 'error' || t.status === 'cancelled') && t.retryable
            ? div({ className: 'xfer-actions' },
              button({ className: 'btn small' }, icon('refresh', { size: 12 }), span('Retry'))
                .on({ click: () => ui.engine.dispatch(new RetryTransferAction(t.id)) }),
              button({ className: 'btn small ghost' }, 'Dismiss')
                .on({ click: () => ui.engine.dispatch(new DismissTransferAction(t.id)) }),
            )
            : null,
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
      button({ className: 'iconbtn x' }, icon('close', { size: 14 })).on({ click: () => ui.engine.dispatch(new ClosePluginPanelAction()) }),
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
