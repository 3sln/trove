// The admin console.
//
// Drive-level administration had accumulated in three places and no place: API keys in
// Settings, storage diagnostics behind a status-bar item, ACLs in a dialog, and the driver
// registry, the indexers and the identity provider only through the API. Each landed where
// it did for a local reason, and the result was that there was nowhere to send someone who
// had just been made an administrator.
//
// A DESTINATION, not a route. 006 introduced share links, and what it actually established
// is that this app does not reflect its state in the address bar — it consumes a share path
// at boot and immediately replaces it with `/`, because a URL that goes stale the moment
// you navigate is worse than one that says nothing. So there is no router to hang a route
// on, and an activity-bar destination beside Plugins and Settings is the consistent answer.
//
// Almost nothing here is new capability. It is gathering: every value below already comes
// from `/api/capabilities`, which the app fetches at startup, or from a query that already
// exists. What was missing was somewhere to look.

import { dd } from '../../runtime.js';
import { watchQuery } from '../../bl/watchQuery.js';
import { grantsFor } from '../../bl/queries.js';
import { icon } from '../icon.js';
import { bytes } from '../format.js';
import { ExecCommandAction, SetGrantAction } from '../../bl/actions.js';

const { div, h2, h3, p, span, button, select, option, input } = dd;

export default function adminView(state, ui) {
  const caps = state.caps;
  return div({ className: 'editor' },
    div({ className: 'stage' },
      div({ className: 'settings admin' },
        h2('Administration'),
        p({ className: 'sub' }, 'How this drive is configured, and what it can do. Most of it is decided by the deployment rather than here.'),
        accessSection(caps, state, ui),
        collectionsSection(state, ui),
        storageSection(caps, state, ui),
        extensionsSection(caps, state),
        workSection(state, ui),
      ),
    ),
  );
}

/** A label/value row, matching the settings screen so the two read as one thing. */
function row(title, detail, value) {
  return div({ className: 'setting' },
    div({ className: 'info' },
      div({ className: 't' }, title),
      detail ? div({ className: 'd' }, detail) : null,
    ),
    div({ className: 'control' }, typeof value === 'string' ? span({ className: 'mono' }, value) : value),
  );
}

/**
 * Who this drive thinks you are, and who it lets in.
 *
 * The identity driver and whether authentication is required are deployment decisions —
 * environment variables, not preferences — so they are reported rather than offered. Which
 * is the point: an admin needs to know what is in force, and previously could only find out
 * by reading the server's configuration or calling the API.
 */
function accessSection(caps, state, ui) {
  const auth = caps?.auth || {};
  const me = caps?.principal || state.so?.me || {};
  const servers = auth.authorizationServers || [];
  return div({ className: 'group' },
    h3('Access'),
    p({ className: 'sub' }, 'Who can reach this drive. Set by the deployment, not here.'),
    row('Signed in as', me.anonymous ? 'This drive does not require a sign-in.' : (me.email || me.id),
      me.anonymous ? 'anonymous' : (me.name || me.id || '—')),
    row('Sign-in required', 'Whether a caller must present a token.',
      caps?.mcp?.requiresAuth ? 'Yes' : 'No'),
    row('Authorization server', 'Where clients are sent to sign in.',
      servers.length ? servers.join(', ') : 'not set'),
    // API keys stay in Settings for now and are LINKED rather than duplicated: two places
    // to revoke a credential is worse than one place in the wrong screen.
    row('API keys', 'Credentials for scripts and services, scoped per collection.',
      button({ className: 'btn small' }, 'In Settings')
        .on({ click: () => ui.engine.dispatch(new ExecCommandAction('workbench.openSettings')) })),
  );
}

/**
 * Every collection, what it sits on, and whether it is sealed.
 *
 * The list an administrator actually wants: not "which one am I looking at" — the switcher
 * in the status bar answers that — but what exists, on what, under which key. Rows and their
 * actions come from the engine (`collectionAdmin`), so this only draws.
 */
function collectionsSection(state, ui) {
  const admin = state.ex?.collectionAdmin;
  const rows = admin?.rows || [];
  // SEQUENCED, not fired together. `dispatch()` returns a feed rather than a promise, so
  // `forEach(dispatch)` starts everything at once — and these pairs are switch-then-do,
  // where the second only means anything after the first has landed. Fired concurrently,
  // "Rotate key…" opened Settings and was then thrown back to home by the switch that had
  // not finished yet. Same shape as platform/commands.js, which got this right first.
  const run = (actions) => async () => {
    for (const action of actions) {
      const settled = await ui.engine.dispatch(action).next(['complete', 'error', 'abort']);
      if (settled?.type !== 'complete') break;
    }
  };
  return div({ className: 'group' },
    h3('Collections'),
    p({ className: 'sub' }, 'What exists on this drive, where its bytes live, and which key seals it.'),
    ...(rows.length ? rows.map((c) => div({ className: 'setting stacked' },
      div({ className: 'info' },
        div({ className: 't' }, c.name, c.current ? span({ className: 'mono muted' }, '  · open') : null),
        div({ className: 'd' },
          c.encrypted
            // The fingerprint is the only way to tell two keys apart across a rotation, and
            // it is safe to show — it is not the key.
            ? `${c.driver} · sealed, key ${String(c.fingerprint).slice(0, 12)}…`
            : `${c.driver} · not encrypted`),
        div({ className: 'd' }, `You may: ${c.capabilities.join(', ') || 'nothing'}`),
      ),
      div({ className: 'control admin-actions' },
        c.current ? null : button({ className: 'btn small' }, 'Open').on({ click: run(c.actions.open) }),
        button({ className: 'btn small' }, 'Scan').on({ click: run(c.actions.scan) }),
        // Routed to Settings rather than started here: the estimate and the confirmation
        // live there, and a rotation begun without seeing its cost is the button nobody
        // should have.
        c.actions.rotate
          ? button({ className: 'btn small' }, 'Rotate key…').on({ click: run(c.actions.rotate) })
          : null,
        // Only offered where you could actually change it — `setGrant` asserts admin, so a
        // button that always showed would be one that sometimes only produces a 403.
        c.actions.access
          ? button({ className: `btn small ${state.wb?.aclFor === c.id ? 'on' : ''}` }, 'Access…')
            .on({ click: run(c.actions.access) })
          : null,
      ),
      // Leased only while open, by a query keyed on this collection — the same shape
      // settingsView uses for `rotationFor`.
      state.wb?.aclFor === c.id
        ? ui.watch(watchQuery(ui.engine, grantsFor(c.id)), (g) => accessEditor(g, ui, c.id))
        : null,
    )) : [row('Collections', 'Nothing has been created yet.', 'none')]),
    admin?.canCreate
      ? div({ className: 'setting' },
        div({ className: 'info' },
          div({ className: 't' }, 'New collection'),
          div({ className: 'd' }, 'A backing store you own — a bucket, a directory, a mount. Encryption is chosen here, at creation.'),
        ),
        div({ className: 'control' },
          button({ className: 'btn small' }, 'Create…').on({ click: run(admin.create) })),
      )
      : row('New collection', 'You do not have permission to create one on this drive.', 'not allowed'),
  );
}

/** The capabilities a grant can carry. `admin` expands to the rest, server-side. */
const CAPS = ['read', 'write', 'delete', 'admin'];

/**
 * Who may do what on one collection.
 *
 * Rendered under the row an administrator opened, and reading `grantsFor(id)` — a query
 * keyed by collection with a `bootAction`, so it loads when this is shown and stops
 * mattering when it is not.
 *
 * Revoking is granting with nothing: one call, so the two cannot drift.
 */
function accessEditor(g, ui, collectionId) {
  if (!g) return div({ className: 'acl' }, span({ className: 'mono muted' }, 'Loading access…'));
  if (g.error) return div({ className: 'acl' }, span({ className: 'mono muted' }, g.error));
  const grants = g.grants || [];
  const set = (grant) => ui.engine.dispatch(new SetGrantAction(collectionId, grant));

  const line = (grant) => {
    const held = new Set(grant.capabilities || []);
    const who = grant.type === 'anyone' ? 'Everyone' : `${grant.type}: ${grant.subject}`;
    return div({ className: 'acl-row' },
      span({ className: 'acl-who' }, who),
      ...CAPS.map((cap) => button({
        className: `btn small ${held.has(cap) ? 'on' : ''}`,
        title: cap === 'admin' ? 'admin implies every other capability' : `toggle ${cap}`,
      }, cap).on({
        click: () => set({
          type: grant.type,
          subject: grant.subject,
          capabilities: held.has(cap)
            ? (grant.capabilities || []).filter((c) => c !== cap)
            : [...(grant.capabilities || []), cap],
        }),
      })),
      // Revoke is the same call with an empty list.
      button({ className: 'btn small', title: 'remove this grant entirely' }, '\u00d7')
        .on({ click: () => set({ type: grant.type, subject: grant.subject, capabilities: [] }) }),
    );
  };

  // Drive administrators, from the deployment's own configuration. Shown because leaving
  // them out makes the list a lie — they hold admin on every collection — and shown
  // WITHOUT controls because `setGrant` cannot touch them: a revoke button here would be
  // one that silently does nothing.
  const admins = (g.admins || []).map((who) => div({ className: 'acl-row acl-fixed' },
    span({ className: 'acl-who' }, who),
    span({ className: 'mono muted' }, 'admin · set by this deployment'),
  ));

  return div({ className: 'acl' },
    ...admins,
    ...(grants.length ? grants.map(line) : (admins.length ? [] : [span({ className: 'mono muted' }, 'Nobody yet.')])),
    div({ className: 'acl-row acl-add' },
      select({ className: 'acl-type' }, option({ value: 'user' }, 'user'), option({ value: 'role' }, 'role'), option({ value: 'anyone' }, 'anyone')),
      input({ className: 'acl-subject', placeholder: 'email, or a role name' }),
      button({ className: 'btn small' }, 'Grant read').on({
        click: (e) => {
          const rowEl = e.target.closest('.acl-add');
          const type = rowEl.querySelector('.acl-type').value;
          const subject = rowEl.querySelector('.acl-subject').value.trim();
          if (type !== 'anyone' && !subject) return;
          set({ type, subject: type === 'anyone' ? '' : subject, capabilities: ['read'] });
        },
      }),
    ),
  );
}

/**
 * What this deployment can actually do with bytes.
 *
 * The driver registry is the list a collection form offers, and it is deployment
 * configuration: `TROVE_STORAGE_DRIVERS` narrows it, and a driver missing from here is the
 * reason a collection cannot be made on it. The capability flags below explain behaviour
 * that otherwise looks arbitrary — why a download is proxied rather than direct, why a
 * usage figure is missing.
 */
function storageSection(caps, state, ui) {
  const s = caps?.storage || {};
  const drivers = caps?.storageDrivers || [];
  const usage = state.ex?.usage;
  const can = (on) => span({ className: `mono ${on ? '' : 'muted'}` }, on ? 'yes' : 'no');
  return div({ className: 'group' },
    h3('Storage'),
    p({ className: 'sub' }, 'The backing stores this deployment offers, and what they support.'),
    row('Drivers offered', 'What a new collection may be created on.',
      drivers.length ? drivers.map((d) => d.label || d.key).join(', ') : 'none registered'),
    row('Direct downloads', 'A presigned URL sends bytes from the store, not through the drive.', can(s.presignDownload)),
    row('Direct uploads', 'A presigned PUT sends bytes to the store, not through the drive.', can(s.presignUpload)),
    row('Multipart', 'Large files go up in parts, resumably.', can(s.multipart)),
    row('Range requests', 'Seeking inside a file without fetching the whole thing.', can(s.range)),
    usage?.total
      ? row('Space', 'Reported by the backing store.', `${bytes(usage.available)} free of ${bytes(usage.total)}`)
      : row('Space', 'This store does not report a total, which object stores generally cannot.', 'not reported'),
    // The check and its remedy already exist as a command — this is where someone would
    // look for it, which is the whole complaint the ticket makes.
    div({ className: 'setting' },
      div({ className: 'info' },
        div({ className: 't' }, 'Check the backing stores'),
        div({ className: 'd' }, 'Asks whether each store can actually be reached from here — the failure that makes every file open to a spinner.'),
      ),
      div({ className: 'control' },
        button({ className: 'btn small' }, 'Run check')
          .on({ click: () => ui.engine.dispatch(new ExecCommandAction('workbench.checkStorage')) })),
    ),
  );
}

/**
 * What extends this drive, and what each extension is permitted.
 *
 * Indexers matter here for a reason that is easy to miss: an indexer reads file CONTENTS,
 * including from an encrypted collection, because indexing happens on the drive's side of
 * the encryption. Anyone weighing what encryption protects needs to know which ones are
 * installed, so the same list appears on the collection form.
 */
function extensionsSection(caps, state) {
  const indexers = caps?.indexers || [];
  const plugins = state.plugins || [];
  return div({ className: 'group' },
    h3('Extensions'),
    p({ className: 'sub' }, 'What reads and adds to this drive.'),
    div({ className: 'setting' },
      div({ className: 'info' },
        div({ className: 't' }, 'Indexers'),
        div({ className: 'd' }, 'They read file contents to make them searchable — including in an encrypted collection, since indexing happens on the drive’s side of the encryption.'),
      ),
      div({ className: 'control' },
        span({ className: 'mono' }, indexers.length ? indexers.map((i) => i.displayName || i.id).join(', ') : 'none')),
    ),
    plugins.length
      ? div({}, ...plugins.map((pl) => div({ className: 'setting' },
        div({ className: 'info' },
          div({ className: 't' }, pl.manifest?.displayName || pl.id),
          div({ className: 'd' }, (pl.grants || []).length
            ? `May: ${(pl.grants || []).join(', ')}`
            : 'Granted nothing — it runs in its sandbox and can only draw.'),
        ),
        div({ className: 'control' }, span({ className: `mono ${pl.status === 'active' ? '' : 'muted'}` }, pl.status || 'idle')),
      )))
      : row('Plugins', 'Installed by an administrator, from a signed package.', 'none installed'),
  );
}

/**
 * What the drive is doing, and what it has not finished.
 *
 * The panel that shows running work already exists and is reached from the status bar,
 * which is fine when something is running and undiscoverable when nothing is. The counts
 * here are the discoverable version; the panel is still where the detail lives.
 */
function workSection(state, ui) {
  const act = state.act || { tasks: [], issues: [] };
  const running = (act.tasks || []).filter((t) => t.status === 'running');
  return div({ className: 'group' },
    h3('Work'),
    p({ className: 'sub' }, 'Background jobs and anything that needs attention.'),
    row('Running now', 'Scans, reindexes and rotations happening on the server.',
      running.length ? `${running.length}` : 'nothing running'),
    row('Needs attention', 'Standing problems — they persist until fixed, unlike a toast.',
      act.issues?.length ? `${act.issues.length}` : 'none'),
    // `stacked`: three buttons do not fit the 200px control column — see styles.css.
    div({ className: 'setting stacked' },
      div({ className: 'info' },
        div({ className: 't' }, 'Maintenance'),
        div({ className: 'd' }, 'A scan picks up files changed in the bucket by something other than Trove. A reindex rebuilds search from scratch.'),
      ),
      div({ className: 'control admin-actions' },
        button({ className: 'btn small' }, 'Activity panel')
          .on({ click: () => ui.engine.dispatch(new ExecCommandAction('workbench.showActivity')) }),
        button({ className: 'btn small' }, 'Scan')
          .on({ click: () => ui.engine.dispatch(new ExecCommandAction('workbench.scanCollection')) }),
        button({ className: 'btn small' }, 'Reindex')
          .on({ click: () => ui.engine.dispatch(new ExecCommandAction('workbench.rebuildIndex')) }),
      ),
    ),
  );
}
