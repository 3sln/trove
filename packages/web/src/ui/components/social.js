// Social UI: the notification bell (title bar) and the info panel (a right rail
// with the active file's tags and threaded conversation). Both render from the
// reactive SocialService; actions call back into it.

import { dd } from '../../runtime.js';
import { icon } from '../icon.js';
import { relativeDate } from '../format.js';
import { OpenFileAction, CopyTextAction, NotifyAction } from '../../bl/actions.js';
import { troveUri } from '@3sln/trove/core/links.js';

const { div, span, button, textarea, input, p } = dd;

const REACTIONS = ['👍', '❤️', '🎉', '👀', '🚀'];

// ---- title-bar principal chip + bell ---------------------------------------

export function principalChip(state) {
  const me = state.so.me;
  // No identity, no profile. On a deployment with no login the server hands back a
  // shared anonymous stand-in; rendering an avatar and a name for it would describe a
  // user who does not exist, and imply an account there is no way to sign in or out of.
  if (!me || me.anonymous) return null;
  const initial = (me.name || me.id || '?')[0].toUpperCase();
  return div({ className: 'principal', title: me.email || me.name || me.id },
    me.picture ? dd.img({ src: me.picture, alt: '', className: 'avatar-img' }) : span({ className: 'avatar-txt' }, initial),
  );
}

export function notificationBell(state, ui) {
  const n = state.so.notifications;
  const social = ui.app.social;
  return div({ className: 'bell-wrap' },
    button({ className: 'iconbtn bell', title: 'Notifications' },
      icon('bell', { size: 19 }),
      n.unread ? span({ className: 'bell-badge' }, String(n.unread > 9 ? '9+' : n.unread)) : null,
    ).on({ click: () => social.toggleInbox() }),
    state.so.inboxOpen ? inboxDropdown(state, ui) : null,
  );
}

function inboxDropdown(state, ui) {
  const items = state.so.notifications.items;
  const social = ui.app.social;
  return div({},
    div({ className: 'scrim', $styling: { background: 'transparent', 'z-index': '54' } }).on({ click: () => social.toggleInbox(false) }),
    div({ className: 'inbox' },
      div({ className: 'inbox-head' },
        span('Notifications'),
        state.so.pushSupported && !state.so.pushEnabled
          ? button({ className: 'link' }, 'Enable push').on({ click: () => social.enablePush() })
          : state.so.pushEnabled ? span({ className: 'muted' }, icon('check', { size: 13 })) : null,
      ),
      items.length
        ? div({ className: 'inbox-items' }, ...items.slice(0, 30).map((note) => inboxItem(note, ui)))
        : div({ className: 'inbox-empty' }, icon('info', { size: 24 }), span('You’re all caught up.')),
    ),
  );
}

function inboxItem(note, ui) {
  const first = note.items?.[0];
  return div({ className: `inbox-item ${note.read ? '' : 'unread'}` },
    div({ className: 'ii-title' }, note.title),
    first?.excerpt ? div({ className: 'ii-excerpt' }, '“' + first.excerpt + '”') : null,
    div({ className: 'ii-time' }, relativeDate(note.createdAt)),
  ).on({
    click: () => {
      if (first?.nodeId) {
        ui.platform.api.stat(first.nodeId).then((r) => {
          ui.go(new OpenFileAction(r.node));
          ui.platform.workbench.toggleInfoPanel(true);
        }).catch((err) => {
          // The item a notification points at can be deleted, or live somewhere the
          // reader lost access to. Either way the click must not just do nothing.
          ui.go(new NotifyAction('warn',
            err?.status === 403 || err?.code === 'forbidden'
              ? 'You no longer have access to that item.'
              : 'That item no longer exists.',
          ));
        });
      }
      ui.app.social.toggleInbox(false);
    },
  });
}

// ---- info panel (tags + conversation) --------------------------------------

export function infoPanel(state, ui) {
  const nav = state.nav;
  const active = nav.activeFile ? { id: nav.activeTabId, node: nav.activeFile } : null;
  const sc = state.so.sidecar;
  return div({ className: 'infopanel' },
    div({ className: 'ip-head' },
      icon('info', { size: 15 }),
      span('Details'),
      button({ className: 'iconbtn', title: 'Close' }, icon('close', { size: 14 })).on({ click: () => ui.platform.workbench.toggleInfoPanel(false) }),
    ),
    !active
      ? div({ className: 'ip-empty' }, span('Open a file to see its tags and conversation.'))
      : div({ className: 'ip-body' },
          fileHeader(active.node, state, ui),
          linkSection(active.node, state, ui),
          tagSection(sc, ui),
          conversationSection(state, sc, ui),
        ),
  );
}

function fileHeader(node, state, ui) {
  const pinned = ui.app.offline.isPinned(node.id);
  return div({ className: 'ip-file' },
    div({ className: 'ip-name' }, node.name),
    div({ className: 'ip-path' }, node.contentType || ''),
    // Secondary, not primary. Pinning a file for offline is a useful thing to be able
    // to do and not the thing you came to this panel for — as the brightest element on
    // screen it out-shouted the file's own links, tags and conversation.
    button({ className: `btn small ${pinned ? 'on' : ''}`, $styling: { 'margin-top': '10px' } },
      icon(pinned ? 'check' : 'download', { size: 14 }),
      pinned ? 'Available offline' : 'Make available offline',
    ).on({ click: () => (pinned ? ui.exec('offline.unpin', node) : ui.exec('offline.pin', node)) }),
  );
}

/**
 * The item's own `trove:` link, and what links to it.
 *
 * With no folders, backlinks are the answer to "where does this live?" — the documents
 * that gather it up. A load failure says so rather than rendering as an empty list,
 * which would read as a fact about the drive instead of about the request.
 */
function linkSection(node, state, ui) {
  const bl = state.so.backlinks;
  const uri = node.collectionId ? troveUri(node) : null;
  const mine = bl && bl.nodeId === node.id ? bl : null;
  return div({ className: 'ip-section' },
    div({ className: 'ip-label' }, 'Links'),
    uri
      ? button({ className: 'ip-uri', title: 'Copy this item’s link' }, icon('link', { size: 12 }), span(uri))
        .on({ click: () => copyLink(ui, uri) })
      : null,
    div({ className: 'ip-label', $styling: { 'margin-top': '10px' } }, 'Linked from'),
    mine?.loading
      ? div({ className: 'ip-muted' }, 'Loading…')
      : mine?.error
        ? div({ className: 'ip-muted error' }, `Couldn’t load links: ${mine.error}`)
        : mine?.items?.length
          ? div({ className: 'ip-backlinks' }, ...mine.items.map((n) =>
            button({ className: 'ip-backlink', title: n.name }, icon('file-text', { size: 12 }), span(n.name))
              .on({ click: () => ui.go(new OpenFileAction(n)) })))
          : div({ className: 'ip-muted' }, 'Nothing links here yet.'),
  );
}

function copyLink(ui, uri) {
  ui.go(new CopyTextAction(uri, `Copied ${uri}`));
}

function tagSection(sc, ui) {
  const tags = sc?.tags || [];
  return div({ className: 'ip-section' },
    div({ className: 'ip-label' }, 'Tags'),
    div({ className: 'tags' },
      ...tags.map((t) =>
        span({ className: 'tag' },
          t.value ? `${t.name}: ${t.value}` : t.name,
          button({ className: 'tag-x' }, icon('close', { size: 11 })).on({ click: () => ui.app.social.removeTag(t.name) }),
        ),
      ),
      input({ className: 'tag-input', placeholder: '+ tag', value: '' }).on({
        keydown: (e) => {
          if (e.key === 'Enter' && e.target.value.trim()) {
            const raw = e.target.value.trim();
            const [name, ...rest] = raw.split(':');
            ui.app.social.addTag(name.trim(), rest.join(':').trim() || undefined);
            e.target.value = '';
          }
        },
      }),
    ),
  );
}

function conversationSection(state, sc, ui) {
  if (sc?.loading) return div({ className: 'ip-section' }, div({ className: 'spinner' }));
  const comments = sc?.comments || [];
  // On a load failure, don't render a false "No comments yet" — say it couldn't load
  // and offer a retry, so the user doesn't post into what looks like an empty thread.
  const body = sc?.error
    ? div({ className: 'conv-empty' },
        span(`Couldn't load the conversation: ${sc.error}`),
        button({ className: 'btn', $styling: { 'margin-top': '8px' } }, 'Retry').on({ click: () => ui.app.social.loadSidecar(sc.nodeId) }))
    : comments.length
      ? div({ className: 'thread' }, ...comments.map((c) => commentNode(c, state, ui, 0)))
      : div({ className: 'conv-empty' }, 'No comments yet. Start the discussion — use @ to mention someone.');
  return div({ className: 'ip-section conv' },
    div({ className: 'ip-label' }, `Conversation${sc?.commentCount ? ` · ${sc.commentCount}` : ''}`),
    body,
    sc?.error ? null : composer(state, ui),
  );
}

function commentNode(c, state, ui, depth) {
  const me = state.so.me;
  const social = ui.app.social;
  const mine = me && c.author?.id === me.id;
  return div({ className: 'comment', $styling: depth ? { marginLeft: '18px' } : {} },
    div({ className: 'c-head' },
      span({ className: 'c-avatar' }, (c.author?.name || '?')[0].toUpperCase()),
      span({ className: 'c-author' }, c.author?.name || c.author?.id || 'Someone'),
      span({ className: 'c-time' }, relativeDate(c.createdAt), c.edited ? ' · edited' : ''),
    ),
    c.deleted
      ? div({ className: 'c-body deleted' }, 'comment deleted')
      : div({ className: 'c-body' }, renderBody(c.body)),
    !c.deleted ? div({ className: 'c-actions' },
      ...REACTIONS.map((emoji) => {
        const users = c.reactions?.[emoji] || [];
        return button({ className: `react ${users.includes(me?.id) ? 'on' : ''}` }, emoji, users.length ? span({ className: 'rc' }, String(users.length)) : null)
          .on({ click: () => social.react(c.id, emoji) });
      }),
      button({ className: 'c-link' }, 'Reply').on({ click: () => social.setReplyTo({ id: c.id, author: c.author }) }),
      mine ? button({ className: 'c-link danger' }, 'Delete').on({ click: () => social.deleteComment(c.id) }) : null,
    ) : null,
    (c.replies || []).length ? div({ className: 'replies' }, ...c.replies.map((r) => commentNode(r, state, ui, depth + 1))) : null,
  ).key(c.id);
}

function composer(state, ui) {
  const social = ui.app.social;
  const me = state.so.me;
  const replyTo = state.so.replyTo;
  // `me` is null only when /api/me didn't answer — offline, or refused. It is NOT the
  // anonymous case (an anonymous deployment returns a real anonymous principal), so
  // "Sign in to join the conversation" was shown to people with nowhere to sign in,
  // and to people who were merely offline. Say which it is, and offer the one action
  // that helps: Trove ships no login of its own, so signing in means letting the
  // identity proxy in front of it redirect a fresh page load.
  if (!me) {
    if (!state.off?.online) {
      return div({ className: 'conv-signin' }, 'You’re offline. Conversations come back when you reconnect.');
    }
    return div({ className: 'conv-signin' },
      span('You’re signed out, so you can read this conversation but not add to it.'),
      button({ className: 'c-link' }, 'Reload to sign in').on({ click: () => window.location.reload() }),
    );
  }
  return div({ className: 'composer' },
    replyTo ? div({ className: 'replying' }, `Replying to ${replyTo.author?.name || 'comment'}`,
      button({ className: 'c-link' }, 'cancel').on({ click: () => social.setReplyTo(null) })) : null,
    textarea({ className: 'composer-input', placeholder: 'Write a comment…  @mention someone', rows: 2, value: '' }).on({
      keydown: (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          social.comment(e.target.value);
          e.target.value = '';
        }
      },
    }),
    div({ className: 'composer-actions' },
      span({ className: 'muted' }, '⌘/Ctrl + Enter'),
      button({ className: 'btn primary', disabled: state.so.posting }, 'Comment').on({
        click: (e) => {
          const box = e.target.closest('.composer').querySelector('.composer-input');
          social.comment(box.value);
          box.value = '';
        },
      }),
    ),
  );
}

// Render @[Name](id) tokens and bare @handles as highlighted mentions.
function renderBody(text) {
  const out = [];
  const re = /@\[([^\]]+)\]\(([^)]+)\)|(?:^|\s)@([a-zA-Z0-9._@-]{2,})/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index + (m[3] ? (m[0].startsWith(' ') ? 1 : 0) : 0)));
    out.push(span({ className: 'mention' }, '@' + (m[1] || m[3])));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
