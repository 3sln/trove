import { dd } from '../../runtime.js';
import { prettyKey } from '../../platform/keybindings.js';

const { div, h2, h3, p, span, select, option, input, label } = dd;

export default function settingsView(state, ui) {
  const groups = ui.platform.settings.grouped();
  return div({ className: 'editor' },
    div({ className: 'stage' },
      div({ className: 'settings' },
        h2('Settings'),
        p({ className: 'sub' }, 'Preferences are stored in this browser. Plugins contribute their own settings here too.'),
        ...groups.map((g) => group(g, ui)),
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
    return input({
      className: 'input', type: 'number', value: s.value,
      $attrs: { min: s.minimum ?? '', max: s.maximum ?? '' },
    }).on({ change: (e) => set(Number(e.target.value)) });
  }
  return input({ className: 'input', value: s.value ?? '' }).on({ change: (e) => set(e.target.value) });
}

function keybindingsSection(ui) {
  const bindings = ui.platform.keybindings.resolved();
  const cmds = ui.platform.contributions.commands;
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
