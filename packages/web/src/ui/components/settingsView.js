import { dd } from '../../runtime.js';
import { eventToKey } from '../../platform/keybindings.js';
import { icon } from '../icon.js';
import { rotationFor } from '../../bl/queries.js';
import { watchQuery } from '../../bl/watchQuery.js';
import { BeginRotationAction, CancelRotationAction, CopyTextAction, ExecCommandAction, PatchApiKeyDraftAction, RebindKeyAction, RememberOpenerAction, SetSettingAction, SetViewStateAction, ToggleApiKeyCapAction } from '../../bl/actions.js';

const { div, h2, h3, p, span, select, option, input, label, button, ul, li, code } = dd;

export default function settingsView(state, ui, regions) {
  const groups = state.settingsGroups || new Map();
  return div({ className: 'editor' },
    div({ className: 'stage' },
      div({ className: 'settings' },
        h2('Settings'),
        p({ className: 'sub' }, 'Preferences are stored in this browser. Plugins contribute their own settings here too.'),
        ...groups.map((g) => group(g, ui)),
        mcpSection(ui, state.caps),
        encryptionSection(state, ui),
        apiKeysSection(state, ui),
        openersSection(state.assoc, ui),
        regions.keybindings(),
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
  const set = (v) => ui.engine.dispatch(new SetSettingAction(s.key, v));
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
function mcpSection(ui, caps) {
  if (!caps) return null; // capabilities never arrived; the shell has bigger problems
  const mcp = caps.mcp;
  const auth = caps.auth || { authorizationServers: [], source: 'none' };
  if (!mcp?.enabled) {
    return div({ className: 'group' }, h3('AI agents (MCP)'),
      p({ className: 'sub' }, 'MCP is switched off on this server. Set TROVE_MCP=on to enable it.'));
  }

  // The "denied clipboard still has to hand the value over" reasoning moved into
  // CopyTextAction, which is where the other three copies of it went too.
  const copy = (text) => () => ui.engine.dispatch(new CopyTextAction(text));

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
// --- API keys -------------------------------------------------------------------

const CAPS = [
  { id: 'read', label: 'Read', hint: 'list and download' },
  { id: 'write', label: 'Write', hint: 'upload and rename' },
  { id: 'delete', label: 'Delete', hint: 'trash and purge' },
  { id: 'admin', label: 'Admin', hint: 'includes all of the above' },
];

const ANY = '*';

function apiKeysSection(state, ui) {
  const keys = state.keys || {};

  // Nothing to dispatch from here. The list is loaded by the query's `bootAction` — it
  // arrives because something is LOOKING at it, which is what makes it lazy without a
  // module-level flag and a render with a side effect. See bl/queries.js.
  //
  // A non-admin's 403 is the correct answer rather than an error: the section simply is
  // not part of their settings screen.
  if (keys.forbidden) return null;
  if (keys.error) {
    return div({ className: 'group' },
      h3('API keys'),
      // Said out loud. This used to render nothing at all on any failure, because the
      // catch set `loaded` as well as `error` — so one dropped request left a blank space
      // where the section belongs, with no message and no way to try again.
      p({ className: 'sub' }, `Couldn’t load the key list: ${keys.error}`),
      div({ className: 'keys-actions' },
        button({ className: 'btn' }, 'Try again')
          .on({ click: () => ui.engine.dispatch(new ExecCommandAction('keys.load')) })),
    );
  }
  if (!keys.loaded) return null;

  const collections = state.ex?.collections || [];

  return div({ className: 'group' },
    h3('API keys'),
    p({ className: 'sub' },
      'Give a script or a service access without giving it an account. A key carries '
      + 'capabilities and no identity, so anything it does is attributed to the key rather '
      + 'than to a person \u2014 and it can only reach the collections you scope it to.'),

    keys.minted ? mintedBanner(keys.minted, ui) : null,
    keys.draft ? draftForm(keys, collections, ui) : null,

    !keys.draft && !keys.minted
      ? div({ className: 'keys-actions' },
        button({ className: 'btn' }, icon('plus', { size: 14 }), 'New key')
          .on({ click: () => ui.engine.dispatch(new ExecCommandAction('keys.new')) }))
      : null,

    keys.keys?.length
      ? div({ className: 'keys-list' }, ...keys.keys.map((k) => keyRow(k, keys, collections, ui)))
      : div({ className: 'keys-empty' }, 'No keys yet.'),
  );
}

/**
 * The secret, shown once.
 *
 * Deliberately loud and deliberately blocking the rest of the section: the server stored
 * only a hash, so this is the only moment the value exists anywhere. A quiet row in a
 * table would be dismissed without being copied.
 */
function mintedBanner(minted, ui) {
  const copy = () => ui.engine.dispatch(new CopyTextAction(minted.secret, 'Key copied'));
  return div({ className: 'key-minted' },
    div({ className: 'key-minted-head' },
      icon('warn', { size: 15 }),
      span(`\u201c${minted.key.name}\u201d is ready \u2014 copy it now.`),
    ),
    p({ className: 'key-minted-note' },
      'This is the only time it can be shown. It is stored as a hash, so it cannot be '
      + 'recovered \u2014 if it is lost, revoke the key and make another.'),
    div({ className: 'key-secret' },
      code({ className: 'mono' }, minted.secret),
      button({ className: 'btn small', title: 'Copy' }, icon('link', { size: 13 })).on({ click: copy }),
    ),
    div({ className: 'keys-actions' },
      button({ className: 'btn' }, 'Done').on({ click: () => ui.engine.dispatch(new ExecCommandAction('keys.dismissMinted')) }),
    ),
  );
}

function draftForm(keys, collections, ui) {
  const draft = keys.draft;
  // Resolved by the apiKeys view: what this draft would actually grant, or null when it
  // would grant nothing.
  const scopes = keys.draftScopes;
  const ready = !!draft.name.trim() && !!scopes;

  return div({ className: 'key-form' },
    div({ className: 'setting' },
      div({ className: 'info' },
        div({ className: 't' }, 'Name'),
        div({ className: 'd' }, 'What it is for. This is what the list shows, so make it recognisable.'),
      ),
      div({ className: 'control' },
        input({ className: 'input', value: draft.name, $attrs: { placeholder: 'CI uploader' } })
          .on({ input: (e) => ui.engine.dispatch(new PatchApiKeyDraftAction({ name: e.target.value })) }),
      ),
    ),

    div({ className: 'setting' },
      div({ className: 'info' },
        div({ className: 't' }, 'Expires after'),
        div({ className: 'd' }, 'Days from now. Leave blank and it never expires.'),
      ),
      div({ className: 'control' },
        input({
          className: 'input', type: 'number', value: draft.expiresInDays,
          $attrs: { min: '1', max: '3650', placeholder: 'never' },
        }).on({ input: (e) => ui.engine.dispatch(new PatchApiKeyDraftAction({ expiresInDays: e.target.value })) }),
      ),
    ),

    div({ className: 'key-scopes' },
      div({ className: 'key-scopes-head' },
        div({ className: 't' }, 'What it may do'),
        div({ className: 'd' },
          'Per collection. A key with nothing ticked grants nothing and cannot be created.'),
      ),
      scopeRow({ id: ANY, name: 'All collections', wildcard: true }, draft, ui),
      ...collections.map((c) => scopeRow(c, draft, ui)),
    ),

    div({ className: 'keys-actions' },
      button({ className: 'btn primary', $attrs: ready ? {} : { disabled: 'true' } },
        keys.busy === 'mint' ? 'Creating\u2026' : 'Create key')
        .on({ click: () => ready && ui.engine.dispatch(new ExecCommandAction('keys.mint')) }),
      button({ className: 'btn' }, 'Cancel').on({ click: () => ui.engine.dispatch(new ExecCommandAction('keys.cancel')) }),
    ),
  );
}

function scopeRow(collection, draft, ui) {
  const held = new Set(draft.caps[collection.id] || []);
  return div({ className: `key-scope ${collection.wildcard ? 'wildcard' : ''}` },
    div({ className: 'key-scope-name' },
      icon(collection.wildcard ? 'grid' : 'files', { size: 14 }),
      span(collection.name || collection.id),
    ),
    div({ className: 'key-scope-caps' },
      ...CAPS.map((c) => label({ className: `cap ${held.has(c.id) ? 'on' : ''}`, title: c.hint },
        input({ type: 'checkbox', checked: held.has(c.id) })
          .on({ change: () => ui.engine.dispatch(new ToggleApiKeyCapAction(collection.id, c.id)) }),
        span(c.label),
      )),
    ),
  );
}

function keyRow(k, keys, collections, ui) {
  const revoked = !!k.revokedAt;
  const expired = k.expiresAt != null && k.expiresAt <= Date.now();
  const dead = revoked || expired;
  return div({ className: `key-row ${dead ? 'dead' : ''}` },
    div({ className: 'key-row-main' },
      div({ className: 'key-row-name' },
        span({ className: 't' }, k.name),
        revoked ? span({ className: 'key-tag' }, 'revoked')
          : expired ? span({ className: 'key-tag' }, 'expired') : null,
      ),
      div({ className: 'key-row-scopes' }, ...scopeSummary(k, collections)),
      div({ className: 'key-row-meta' }, metaLine(k)),
    ),
    !dead
      ? button({
        className: 'btn small danger',
        $attrs: keys.busy === k.id ? { disabled: 'true' } : {},
      }, keys.busy === k.id ? '\u2026' : 'Revoke').on({ click: () => ui.engine.dispatch(new ExecCommandAction('keys.revoke', k.id)) })
      : null,
  );
}

function scopeSummary(k, collections) {
  // The name if we know it, the id if we do not. A key can outlive the collection it was
  // scoped to, and showing a bare id then is more honest than showing nothing — it is
  // also the thing you would search for to find out what happened to it.
  const nameOf = (id) => collections.find((c) => c.id === id)?.name || id;
  return (k.scopes || []).map((s) => span({ className: 'key-chip' },
    span({ className: 'where' }, s.collectionId === ANY ? 'all collections' : nameOf(s.collectionId)),
    span({ className: 'what' }, s.capabilities.join(' \u00b7 ')),
  ));
}

function metaLine(k) {
  const when = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const bits = [`created ${when(k.createdAt)}`];
  if (k.createdBy) bits.push(`by ${k.createdBy}`);
  // "Never used" is the more useful of the two facts: it is how you find the key nobody
  // needs and can safely revoke.
  bits.push(k.lastUsedAt ? `last used ${when(k.lastUsedAt)}` : 'never used');
  if (k.expiresAt) bits.push(`expires ${when(k.expiresAt)}`);
  return bits.join(' \u00b7 ');
}

/**
 * The open collection's key: which one it is, and moving it to a new one.
 *
 * Only for an encrypted collection, and only for an admin — a non-admin gets a 403 reading
 * the rotation state, which is the correct answer rather than an error, so the section
 * simply is not drawn.
 */
function encryptionSection(state, ui) {
  const collectionId = state.ex?.collectionId;
  const enc = state.ex?.collections?.find((c) => c.id === collectionId)?.encryption;
  if (!enc?.enabled) return null;
  // Watching the query is what LOADS it — its bootAction reads the rotation state and its
  // realization polls while one is running. Nothing fetches while this screen is closed.
  return ui.watch(watchQuery(ui.engine, rotationFor(collectionId)), (rot) => encryptionBody(enc, rot || {}, ui));
}

function encryptionBody(enc, rot, ui) {
  const running = rot.rotation?.status === 'running';
  const est = rot.estimate;

  return div({ className: 'group' },
    h3('Encryption'),
    p({ className: 'sub' }, 'Files in this collection are sealed before they leave your browser. The drive holds the key.'),

    // The only thing that identifies which key the collection is on, and what a sideloaded
    // object is matched against — so it has to be somewhere findable and copyable.
    div({ className: 'setting' },
      div({ className: 'info' },
        div({ className: 't' }, 'Key fingerprint'),
        div({ className: 'd' }, 'Identifies the key this collection is on.'),
      ),
      div({ className: 'control' },
        button({ className: 'btn small', title: 'Copy' }, dd.h('code', enc.fingerprint))
          .on({ click: () => ui.engine.dispatch(new CopyTextAction(enc.fingerprint, 'Fingerprint copied')) }),
      ),
    ),

    div({ className: 'setting' },
      div({ className: 'info' },
        div({ className: 't' }, running ? 'Rotating the key' : 'Rotate the key'),
        div({ className: 'd' }, running
          ? `${rot.rotation.moved} moved${rot.rotation.failed ? `, ${rot.rotation.failed} failed` : ''} — this continues in the background.`
          : rotationCost(est)),
      ),
      div({ className: 'control' },
        running
          ? button({ className: 'btn small', disabled: !!rot.busy }, 'Stop')
            .on({ click: () => ui.engine.dispatch(new CancelRotationAction()) })
          : button({ className: 'btn small', disabled: !!rot.busy }, 'Rotate')
            .on({ click: () => ui.engine.dispatch(new BeginRotationAction()) }),
      ),
    ),
    running
      ? null
      // Said before it is started rather than after: what has moved stays moved, so this
      // is not a job that can be undone by regretting it.
      : div({},
        rotationBill(est),
        p({ className: 'sub' }, 'Every file is re-sealed under a new key and the old one is retired once nothing is left on it. Files stay readable throughout.'),
      ),
  );
}

/**
 * What a rotation would cost, before anyone starts one.
 *
 * The server already composes this in words — it knows the provider and its pricing, and
 * whether anyone is billed at all — so this shows what it said rather than recomputing a
 * worse version from a file count. `applicable` is false for a store nobody charges for,
 * where the only cost is time.
 */
function rotationCost(est) {
  if (!est) return 'Re-seals every file under a fresh key.';
  return est.summary || 'Re-seals every file under a fresh key.';
}

/** The itemised estimate, when the provider charges for the traffic. */
function rotationBill(est) {
  if (!est?.applicable || !(est.lines || []).length) return null;
  return div({ className: 'rot-bill' },
    ...est.lines.map((l) => div({ className: 'rb-line' },
      span(l.label || l.name || ''), span({ className: 'mono' }, l.amount || l.value || ''))),
    est.total ? div({ className: 'rb-line total' }, span('Estimated total'), span({ className: 'mono' }, est.total)) : null,
    // Prices move and this is a guess against a snapshot of them; saying when stops it
    // reading as a quote.
    est.asOf ? div({ className: 'rb-asof' }, `Prices as of ${est.asOf}.`) : null,
  );
}

function openersSection(rows, ui) {
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
                  .on({ click: () => ui.engine.dispatch(new RememberOpenerAction(r.typeKey, null)) }),
              ),
            ),
          ),
        )
      : p({ className: 'sub', $styling: { margin: 0 } }, 'No default openers set yet. When a file type has more than one viewer, you can pick one and check “Always use this”.'),
  );
}

// Which shortcut is listening for its new chord. Transient, and still engine state: it
// decides whether a row renders a `<kbd>` or "Press keys…". See bl/viewState.js.
export const CAPTURE = 'keybindingCapture';

// Its own region, over the keybindings view and the capture state.
//
// Everything a row needs is decided by the query — the command's title, whether the user
// changed it, and whether another command answers to the same chord. That last one is not
// something a row could work out for itself: it needs the whole list at once.
//
// Rebinding dispatches with the binding ID. The component has never held a binding object,
// only a description of one, which is the point.
// Built once and PASSED IN, beside the other regions in ui/compositions/workbench.js. It
// was built at module scope with `kbRegion ??= region(ui.engine, …)` — right that a region
// must be built once, wrong about where: at module scope it captures the FIRST `ui` and
// engine it ever sees and pins them for the module's life, which is the shape `watchQuery`
// deliberately avoids by keying its cache on the engine. Folding it into the parent
// settingsView region would also work and costs granularity — a chord capture would
// re-render the whole settings screen — so it is handed down instead.

export function keybindingRows(bindings, ui, capturing) {
  const setCapturing = (id) => ui.engine.dispatch(new SetViewStateAction(CAPTURE, id));
  const stop = () => setCapturing(null);
  const rebind = (bindingId, key) => ui.engine.dispatch(new RebindKeyAction(bindingId, key));
  return div({ className: 'group' },
    h3('Keyboard Shortcuts'),
    p({ className: 'sub' }, 'Click a shortcut to record a new one. Esc cancels; Backspace clears it.'),
    // Every binding, not the first 40. The cap was arbitrary and silent — with no "N
    // more" anywhere, the shortcuts past it simply did not exist as far as anyone could
    // tell, and one plugin keymap was enough to push real ones off the end.
    ...bindings.map((b) => {
      const listening = capturing === b.bindingId;
      return div({ className: 'setting' },
        div({ className: 'info' },
          div({ className: 't' }, b.title),
          div({ className: 'd' }, b.command),
        ),
        div({ className: 'control' },
          b.clash && !listening
            ? span({ className: 'kbd-clash', title: 'Another command answers to this shortcut too — the one registered last wins' },
              icon('warn', { size: 12 }))
            : null,
          button({ className: `kbd-edit ${listening ? 'listening' : ''} ${b.clash ? 'clash' : ''}`, title: listening ? 'Press the new shortcut' : 'Click to rebind' },
            listening ? span('Press keys…') : dd.h('kbd', b.label))
            .on({
              click: () => setCapturing(listening ? null : b.bindingId),
              blur: () => { if (listening) stop(); },
              keydown: (e) => {
                if (!listening) return;
                e.preventDefault();
                e.stopPropagation();
                if (e.key === 'Escape') return stop();
                if (e.key === 'Backspace') { rebind(b.bindingId, null); return stop(); }
                // A bare modifier isn't a chord yet — wait for the key it modifies.
                if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return;
                rebind(b.bindingId, eventToKey(e));
                stop();
              },
              $attach: (el) => { if (listening) queueMicrotask(() => el.focus()); },
            }),
          b.custom
            ? button({ className: 'c-link', title: 'Back to the default' }, 'reset')
              .on({ click: () => { rebind(b.bindingId, null); setCapturing(null); } })
            : null,
        ),
      );
    }),
  );
}
