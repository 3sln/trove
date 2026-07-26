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
// Read-only, and deliberately so. Everything here is DEPLOYMENT configuration — which
// identity provider issues the tokens, where the endpoint lives — supplied by the
// environment or by whoever constructed the server. Pointing the drive at a different
// authorization server changes who can reach every file in it, which is a `docker run`
// decision rather than a preference, and a settings field would make it look otherwise.
//
// What this section is FOR is the two questions a self-hoster has and currently cannot
// answer: what URL do I paste into my assistant, and why does it say 401. The second is
// why `needsAuthorizationServer` is called out as a problem — a drive with auth on and
// no authorization server configured looks perfectly set up and cannot work.
//
// It reads straight off `capabilities`, which the app already fetched at startup, so
// there is no loading state and nothing to go stale.
function mcpSection(ui) {
  const caps = ui.platform.capabilities;
  if (!caps) return null; // capabilities never arrived; the shell has bigger problems
  const mcp = caps.mcp;
  const auth = caps.auth || { authorizationServers: [], source: 'none' };
  if (!mcp?.enabled) {
    return div({ className: 'group' }, h3('AI agents (MCP)'),
      p({ className: 'sub' }, 'MCP is switched off on this server. Set TROVE_MCP=on to enable it.'));
  }

  const copy = (text) => () => {
    navigator.clipboard?.writeText(text)
      .then(() => ui.platform.notifications.success('Copied'))
      // Clipboard access is denied often enough that failing silently would look like a
      // broken button; showing the value still gets it into the user's hands.
      .catch(() => ui.platform.notifications.info(text, { sticky: true }));
  };

  const servers = auth.authorizationServers || [];
  // Where the value came from matters when it is wrong: "we took this from your JWT
  // issuer" points at a different file than "you set this".
  const provenance = auth.source === 'jwt-issuer' ? 'from TROVE_JWT_ISSUER'
    : auth.source === 'configured' ? 'from TROVE_AUTH_SERVER' : null;

  return div({ className: 'group' },
    h3('AI agents (MCP)'),
    p({ className: 'sub' }, 'Point an AI assistant at this drive. It signs in as you and sees exactly the collections you can see.'),

    div({ className: 'setting' },
      div({ className: 'info' },
        div({ className: 't' }, 'Server URL'),
        div({ className: 'd' }, 'Paste this into your assistant\u2019s MCP settings.'),
      ),
      div({ className: 'control mcp-url' },
        span({ className: 'mono' }, mcp.endpoint),
        button({ className: 'btn small', title: 'Copy' }, icon('link', { size: 13 })).on({ click: copy(mcp.endpoint) }),
      ),
    ),

    div({ className: 'setting' },
      div({ className: 'info' },
        div({ className: 't' }, 'Sign-in required'),
        div({ className: 'd' }, mcp.requiresAuth
          ? 'Agents must present a token, the same one this browser uses.'
          : 'This drive is open, so agents connect without a token \u2014 exactly like the web app does.'),
      ),
      div({ className: 'control' }, span({ className: 'mono' }, mcp.requiresAuth ? 'Yes' : 'No')),
    ),

    // The failure that looks like success. Before the value, because it is the answer
    // to "I set this up and my agent just says 401".
    mcp.needsAuthorizationServer
      ? div({ className: 'mcp-warn' }, icon('warn', { size: 15 }),
        span('This drive requires a token but no authorization server is set, so an agent has '
          + 'nowhere to sign in. Set TROVE_AUTH_SERVER (or TROVE_JWT_ISSUER) to the issuer URL '
          + 'of your identity provider and restart.'))
      : null,

    div({ className: 'setting' },
      div({ className: 'info' },
        div({ className: 't' }, 'Authorization server'),
        div({ className: 'd' }, 'Where clients are sent to sign in \u2014 for the whole drive, not just for agents. '
          + 'Set with TROVE_AUTH_SERVER; defaults to TROVE_JWT_ISSUER when that is set.'),
      ),
      div({ className: 'control' },
        servers.length
          ? span({ className: 'mono' }, servers.join(', ') + (provenance ? ` (${provenance})` : ''))
          : span({ className: 'mono muted' }, 'not set'),
      ),
    ),

    div({ className: 'setting' },
      div({ className: 'info' },
        div({ className: 't' }, 'Discovery document'),
        div({ className: 'd' }, 'What a client reads to find out how to authenticate (RFC 9728).'),
      ),
      div({ className: 'control mcp-url' }, span({ className: 'mono small' }, auth.metadataUrl)),
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
