// Social UI: the notification bell (title bar) and the info panel (a right rail
// with the active file's tags and threaded conversation). Both render from the
// reactive SocialService; actions call back into it.

import { dd } from '../../runtime.js';
import { icon } from '../icon.js';
import { relativeDate } from '../format.js';
import { OpenFileAction } from '../../bl/actions.js';

const { div, span, button, textarea, input, p } = dd;

const REACTIONS = ['👍', '❤️', '🎉', '👀', '🚀'];

// ---- title-bar principal chip + bell ---------------------------------------

export function principalChip(state) {
  const me = state.so.me;
  if (!me) return null;
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
    div({ className: 'scrim', $styling: { background: 'transparent', zIndex: '54' } }).on({ click: () => social.toggleInbox(false) }),
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
        }).catch(() => {});
      }
      ui.app.social.toggleInbox(false);
    },
  });
}

// ---- info panel (tags + conversation) --------------------------------------

export function infoPanel(state, ui) {
  const wb = state.wb;
  const active = wb.activeFile ? { id: wb.activeTabId, node: wb.activeFile } : null;
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
          tagSection(sc, ui),
          conversationSection(state, sc, ui),
        ),
  );
}

function fileHeader(node, state, ui) {
  const pinned = node.kind === 'file' && ui.app.offline.isPinned(node.id);
  return div({ className: 'ip-file' },
    div({ className: 'ip-name' }, node.name),
    div({ className: 'ip-path' }, node.path),
    node.kind === 'file'
      ? button({ className: `btn ${pinned ? '' : 'primary'}`, $styling: { marginTop: '10px', padding: '6px 11px' } },
          icon(pinned ? 'check' : 'download', { size: 14 }),
          pinned ? 'Available offline' : 'Make available offline',
        ).on({ click: () => (pinned ? ui.exec('offline.unpin', node) : ui.exec('offline.pin', node)) })
      : null,
  );
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
  return div({ className: 'ip-section conv' },
    div({ className: 'ip-label' }, `Conversation${sc?.commentCount ? ` · ${sc.commentCount}` : ''}`),
    comments.length
      ? div({ className: 'thread' }, ...comments.map((c) => commentNode(c, state, ui, 0)))
      : div({ className: 'conv-empty' }, 'No comments yet. Start the discussion — use @ to mention someone.'),
    composer(state, ui),
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
  if (!me) return div({ className: 'conv-signin' }, 'Sign in to join the conversation.');
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
