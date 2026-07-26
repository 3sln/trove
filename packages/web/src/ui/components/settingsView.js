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
        mcpSection(ui),
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

// Connecting an AI agent to this drive.
//
// Unlike everything above it, this is SERVER state, not a browser preference — pointing
// the drive at a different authorization server changes who can reach every file in it,
// for everyone. So it is read from the server, only an admin can write it, and it is
// loaded lazily: someone opening Settings to change their theme should not be issuing an
// admin query on the way in.
//
// The section exists mostly to answer two questions a self-hoster has and currently
// cannot: what URL do I paste into my agent, and why does it say 401. The second is the
// reason `needsAuthorizationServer` is called out as a problem rather than shown as an
// empty field — a drive with auth on and no authorization server configured looks
// perfectly set up and cannot work.
let mcpState = { status: 'idle', info: null, error: null, draft: null, saving: false };

function loadMcp(ui) {
  mcpState = { ...mcpState, status: 'loading' };
  ui.platform.api.mcp()
    .then((info) => { mcpState = { ...mcpState, status: 'ready', info, error: null }; })
    .catch((err) => { mcpState = { ...mcpState, status: 'ready', error: err.message }; })
    .finally(() => ui.rerender());
}

function mcpSection(ui) {
  if (mcpState.status === 'idle') {
    // Kick the load off after this render rather than during it.
    queueMicrotask(() => loadMcp(ui));
    return div({ className: 'group' }, h3('AI agents (MCP)'), p({ className: 'sub' }, 'Checking…'));
  }
  const { info, error } = mcpState;
  if (error) {
    return div({ className: 'group' }, h3('AI agents (MCP)'),
      p({ className: 'sub' }, `Couldn’t read the MCP configuration: ${error}`));
  }
  if (!info?.enabled) {
    return div({ className: 'group' }, h3('AI agents (MCP)'),
      p({ className: 'sub' }, 'MCP is switched off on this server. Set TROVE_MCP=on to enable it.'));
  }

  const draft = mcpState.draft ?? (info.authorizationServers || []).join(', ');
  const copy = (text) => () => {
    navigator.clipboard?.writeText(text)
      .then(() => ui.platform.notifications.success('Copied'))
      // Clipboard access is denied often enough that failing silently would look like
      // a broken button; showing the value still gets it into the user's hands.
      .catch(() => ui.platform.notifications.info(text, { sticky: true }));
  };
  const save = () => {
    // Read the draft AT CLICK TIME, not from the render closure. Typing mutates
    // mcpState.draft without re-rendering (a controlled input that re-rendered per
    // keystroke would fight the caret), so `draft` above is whatever the field held when
    // this section was last drawn — usually empty.
    const value = mcpState.draft ?? draft;
    mcpState = { ...mcpState, saving: true };
    ui.platform.api.setMcp({ authorizationServers: value.split(',').map((s) => s.trim()).filter(Boolean) })
      .then(() => {
        ui.platform.notifications.success('Saved. Agents will discover the new authorization server.');
        mcpState = { status: 'idle', info: null, error: null, draft: null, saving: false };
      })
      .catch((err) => {
        ui.platform.notifications.error(err.message);
        mcpState = { ...mcpState, saving: false };
      })
      .finally(() => ui.rerender());
  };

  return div({ className: 'group' },
    h3('AI agents (MCP)'),
    p({ className: 'sub' }, 'Point an AI assistant at this drive. It signs in as you and sees exactly the collections you can see.'),

    div({ className: 'setting' },
      div({ className: 'info' },
        div({ className: 't' }, 'Server URL'),
        div({ className: 'd' }, 'Paste this into your assistant’s MCP settings.'),
      ),
      div({ className: 'control mcp-url' },
        span({ className: 'mono' }, info.endpoint),
        button({ className: 'btn small', title: 'Copy' }, icon('link', { size: 13 })).on({ click: copy(info.endpoint) }),
      ),
    ),

    div({ className: 'setting' },
      div({ className: 'info' },
        div({ className: 't' }, 'Sign-in required'),
        div({ className: 'd' }, info.requireAuth
          ? 'Agents must present a token, the same one this browser uses.'
          : 'This drive is open, so agents connect without a token — exactly like the web app does.'),
      ),
      div({ className: 'control' }, span({ className: 'mono' }, info.requireAuth ? 'Yes' : 'No')),
    ),

    // The failure that looks like success. Called out before the input, because it is
    // the answer to "I set this up and my agent just says 401".
    info.needsAuthorizationServer
      ? div({ className: 'mcp-warn' }, icon('warn', { size: 15 }),
        span('This drive requires a token but no authorization server is set, so an agent has '
          + 'nowhere to sign in. Enter the issuer URL of your identity provider below.'))
      : null,

    div({ className: 'setting' },
      div({ className: 'info' },
        div({ className: 't' }, 'Authorization server'),
        div({ className: 'd' }, 'The issuer URL of whatever signs your tokens — Auth0, Keycloak, Cloudflare Access, '
          + 'your own. Agents fetch its OAuth metadata from here and send you there to sign in. '
          + 'Separate several with commas.'),
      ),
      div({ className: 'control' },
        input({
          className: 'input', value: draft, placeholder: 'https://auth.example.com',
          $attrs: info.canEdit ? {} : { disabled: 'true' },
        }).on({ input: (e) => { mcpState.draft = e.target.value; } }),
      ),
    ),
    info.canEdit
      ? div({ className: 'row-actions' },
        button({ className: `btn primary ${mcpState.saving ? 'busy' : ''}` }, mcpState.saving ? 'Saving…' : 'Save')
          .on({ click: save }),
      )
      : p({ className: 'sub', $styling: { margin: 0 } }, 'Only an administrator can change this.'),

    div({ className: 'setting' },
      div({ className: 'info' },
        div({ className: 't' }, 'Discovery document'),
        div({ className: 'd' }, 'What an agent reads to find out how to authenticate (RFC 9728).'),
      ),
      div({ className: 'control mcp-url' }, span({ className: 'mono small' }, info.metadataUrl)),
    ),
  );
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
