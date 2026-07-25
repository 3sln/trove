import { dd } from '../../runtime.js';
import { prettyKey } from '../../platform/keybindings.js';
import { icon } from '../icon.js';
import { listAssociations, rememberOpener } from '../../bl/openers.js';

const { div, h2, h3, p, span, select, option, input, label, button } = dd;

export default function settingsView(state, ui) {
  const groups = ui.platform.settings.grouped();
  return div({ className: 'editor' },
    div({ className: 'stage' },
      div({ className: 'settings' },
        h2('Settings'),
        p({ className: 'sub' }, 'Preferences are stored in this browser. Plugins contribute their own settings here too.'),
        ...groups.map((g) => group(g, ui)),
        openersSection(ui),
        keybindingsSection(ui),
      ),
    ),
  );
}

function group(g, ui) {
  return div({ className: 'group' },
    h3(g.category),
    ...g.items.map((s) => setting(s, ui)),
  );
}

function setting(s, ui) {
  return div({ className: 'setting' },
    div({ className: 'info' },
      div({ className: 't' }, s.title || s.key),
      s.description ? div({ className: 'd' }, s.description) : null,
    ),
    div({ className: 'control' }, control(s, ui)),
  );
}

function control(s, ui) {
  const set = (v) => ui.platform.settings.set(s.key, v);
  if (s.type === 'boolean') {
    return label({ className: 'switch' },
      input({ type: 'checkbox', checked: !!s.value }).on({ change: (e) => set(e.target.checked) }),
      span({ className: 'track' }),
    );
  }
  if (s.type === 'enum') {
    return select({ className: 'input' },
      ...s.enum.map((opt, i) =>
        option({ value: opt, selected: s.value === opt }, (s.enumLabels && s.enumLabels[i]) || opt),
      ),
    ).on({ change: (e) => set(e.target.value) });
  }
  if (s.type === 'number') {
    // Guard against a cleared field (Number('') === 0) or a paste yielding NaN, and
    // clamp to the declared range so downstream consumers never see an invalid value.
    const commit = (e) => {
      let n = Number(e.target.value);
      if (e.target.value === '' || Number.isNaN(n)) { e.target.value = s.value; return; }
      if (s.minimum != null) n = Math.max(s.minimum, n);
      if (s.maximum != null) n = Math.min(s.maximum, n);
      e.target.value = n;
      set(n);
    };
    return input({
      className: 'input', type: 'number', value: s.value,
      $attrs: { min: s.minimum ?? '', max: s.maximum ?? '' },
    }).on({ change: commit });
  }
  return input({ className: 'input', value: s.value ?? '' }).on({ change: (e) => set(e.target.value) });
}

// Default openers per file type — the "always use this" choices from the opener
// chooser. Each row shows the type → viewer; the × forgets it (so the next open of
// that type asks again). Empty when the user hasn't set any defaults.
function openersSection(ui) {
  const rows = listAssociations(ui.platform);
  return div({ className: 'group' },
    h3('Default Openers'),
    rows.length
      ? div({},
          ...rows.map((r) =>
            div({ className: 'setting' },
              div({ className: 'info' },
                div({ className: 't' }, r.typeKey),
                div({ className: 'd' }, r.missing ? `${r.openerTitle} (no longer installed)` : `Opens with ${r.openerTitle}`),
              ),
              div({ className: 'control' },
                button({ className: 'iconbtn', title: 'Forget this default' }, icon('close', { size: 14 }))
                  .on({ click: () => rememberOpener(ui.platform, r.typeKey, null) }),
              ),
            ),
          ),
        )
      : p({ className: 'sub', $styling: { margin: 0 } }, 'No default openers set yet. When a file type has more than one viewer, you can pick one and check “Always use this”.'),
  );
}

function keybindingsSection(ui) {
  const bindings = ui.platform.keybindings.resolved();
  const cmds = ui.platform.contributions;
  return div({ className: 'group' },
    h3('Keyboard Shortcuts'),
    ...bindings.slice(0, 40).map((b) => {
      const cmd = cmds.get(b.command);
      return div({ className: 'setting' },
        div({ className: 'info' },
          div({ className: 't' }, cmd?.title || b.command),
          div({ className: 'd' }, b.command),
        ),
        div({ className: 'control' }, span({ className: 'kbd' }, dd.h('kbd', prettyKey(b.key)))),
      );
    }),
  );
}
