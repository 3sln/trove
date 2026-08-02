// The per-file sidecar document — a small CRDT that holds everything mutable and
// social about a file WITHOUT touching the file bytes: its conversation
// (threaded comments + reactions), its tags, and who's subscribed to the thread.
//
// It does NOT hold indexer output. It advertised a per-indexer `facets` register for a
// long time with no writer and no reader anywhere in core, server, web or the plugin SDK,
// and there is no facet verb on the plugin RPC surface either — so the header was the
// documentation someone extending an indexer would find first, and following it would land
// data nothing queries. Indexer contributions live in the queryable metadata store, which
// is what makes them show up in list/stat and drive tag filtering (see indexing.js).
//
// It's designed to live as cold JSON in object storage and be merged whenever
// it's read-before-write, so two servers (or a stale hot copy vs the cold one)
// converge without a lock or a conflict. Every field is a CRDT register:
//   • tags   — LWW-Element-Set (add/remove wins by Lamport stamp)
//   • comments — grow-only map; body edit & deletion are LWW registers; reactions
//     are an OR-map (per user, per emoji, LWW on/off)
//   • subscribers — LWW register (subscribed / muted)
// A Lamport `clock` orders concurrent ops; ties break on the actor id, so merges
// are deterministic and commutative.

export const SIDECAR_VERSION = 1;

export function emptyDoc(nodeId) {
  return { v: SIDECAR_VERSION, nodeId, clock: 0, tags: {}, comments: {}, subscribers: {} };
}

// A stamp orders and tie-breaks a write. Higher clock wins; equal clock → higher
// actor string wins (arbitrary but total and deterministic).
function newer(a, b) {
  if (!a) return false;
  if (!b) return true;
  if (a.at !== b.at) return a.at > b.at;
  return String(a.actor) >= String(b.actor);
}
function tick(doc) {
  doc.clock = (doc.clock || 0) + 1;
  return doc.clock;
}
function stamp(doc, actor, at) {
  return { at: at ?? tick(doc), actor: actor || 'system' };
}

// ---- mutators (each returns the affected entity) ---------------------------

export function addComment(doc, { id, parentId = null, author, body, mentions = [], actor, at, ts }) {
  const s = stamp(doc, actor ?? author?.id, at);
  const comment = {
    id, parentId, author, body: { text: body, ...s },
    // `at` (Lamport) orders/merges; `createdAt` (wall clock) is for display only.
    mentions, createdAt: ts ?? wallClock(), reactions: {}, deleted: null, ...s,
  };
  doc.comments[id] = comment;
  subscribe(doc, author?.id, { actor: author?.id, at: s.at });
  return comment;
}

function wallClock() {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

export function editComment(doc, id, { body, actor, at }) {
  const c = doc.comments[id];
  if (!c) return null;
  const s = stamp(doc, actor, at);
  if (newer(s, c.body)) c.body = { text: body, ...s };
  return c;
}

export function deleteComment(doc, id, { actor, at } = {}) {
  const c = doc.comments[id];
  if (!c) return null;
  const s = stamp(doc, actor, at);
  if (newer(s, c.deleted)) c.deleted = s;
  return c;
}

export function react(doc, id, emoji, userId, on = true, { at } = {}) {
  const c = doc.comments[id];
  if (!c) return null;
  const s = stamp(doc, userId, at);
  const map = (c.reactions[emoji] ??= {});
  const cur = map[userId];
  if (newer(s, cur)) map[userId] = { on, ...s };
  return c;
}

export function setTag(doc, name, { value = true, actor, at } = {}) {
  const s = stamp(doc, actor, at);
  const cur = doc.tags[name];
  if (newer(s, cur)) doc.tags[name] = { present: true, value, ...s };
  return doc.tags[name];
}
export function removeTag(doc, name, { actor, at } = {}) {
  const s = stamp(doc, actor, at);
  const cur = doc.tags[name];
  if (newer(s, cur)) doc.tags[name] = { present: false, value: cur?.value, ...s };
}

export function subscribe(doc, userId, { muted = false, actor, at } = {}) {
  if (!userId) return;
  const s = stamp(doc, actor ?? userId, at);
  const cur = doc.subscribers[userId];
  if (newer(s, cur)) doc.subscribers[userId] = { subscribed: true, muted, ...s };
}
export function unsubscribe(doc, userId, { actor, at } = {}) {
  if (!userId) return;
  const s = stamp(doc, actor ?? userId, at);
  const cur = doc.subscribers[userId];
  if (newer(s, cur)) doc.subscribers[userId] = { subscribed: false, muted: cur?.muted, ...s };
}

// ---- merge (CRDT join) -----------------------------------------------------

export function mergeDoc(a, b) {
  if (!a) return structuredCloneSafe(b);
  if (!b) return structuredCloneSafe(a);
  const out = { v: SIDECAR_VERSION, nodeId: a.nodeId || b.nodeId, clock: Math.max(a.clock || 0, b.clock || 0), tags: {}, comments: {}, subscribers: {} };

  for (const key of union(a.tags, b.tags)) out.tags[key] = pick(a.tags[key], b.tags[key]);
  // Documents written before the register was removed still carry one, and a merge that
  // dropped half of a stored document would not be a merge. Guarded on presence so it
  // costs nothing on the documents every writer produces now.
  if (a.facets || b.facets) {
    out.facets = {};
    for (const key of union(a.facets, b.facets)) out.facets[key] = pick(a.facets[key], b.facets[key]);
  }
  for (const key of union(a.subscribers, b.subscribers)) out.subscribers[key] = pick(a.subscribers[key], b.subscribers[key]);

  for (const id of union(a.comments, b.comments)) {
    out.comments[id] = mergeComment(a.comments[id], b.comments[id]);
  }
  return out;
}

function mergeComment(x, y) {
  if (!x) return structuredCloneSafe(y);
  if (!y) return structuredCloneSafe(x);
  const base = newer({ at: x.at, actor: x.actor }, { at: y.at, actor: y.actor }) ? x : y;
  const out = { ...structuredCloneSafe(base) };
  out.body = pick(x.body, y.body);
  out.deleted = pick(x.deleted, y.deleted);
  out.reactions = {};
  for (const emoji of union(x.reactions, y.reactions)) {
    out.reactions[emoji] = {};
    const users = union(x.reactions?.[emoji], y.reactions?.[emoji]);
    for (const u of users) out.reactions[emoji][u] = pick(x.reactions?.[emoji]?.[u], y.reactions?.[emoji]?.[u]);
  }
  return out;
}

function pick(a, b) {
  return newer(a, b) ? a : b;
}
function union(a = {}, b = {}) {
  return new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
}
function structuredCloneSafe(o) {
  return JSON.parse(JSON.stringify(o));
}

// ---- view (derive a UI-friendly shape) -------------------------------------

export function viewDoc(doc) {
  const tags = Object.entries(doc.tags || {})
    .filter(([, t]) => t.present)
    .map(([name, t]) => ({ name, value: t.value === true ? null : t.value }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // canonical order

  const all = Object.values(doc.comments || {}).map((c) => ({
    id: c.id, parentId: c.parentId, author: c.author,
    body: c.deleted ? null : c.body?.text, deleted: !!c.deleted,
    // Edited iff the body's Lamport stamp advanced past the comment's own.
    edited: !!c.body && c.body.at !== c.at, createdAt: c.createdAt, at: c.at,
    mentions: c.mentions || [],
    reactions: summariseReactions(c.reactions),
  }));
  all.sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1)); // stable, canonical

  // Thread into a tree.
  const byId = new Map(all.map((c) => [c.id, { ...c, replies: [] }]));
  const roots = [];
  for (const c of byId.values()) {
    if (c.parentId && byId.has(c.parentId)) byId.get(c.parentId).replies.push(c);
    else roots.push(c);
  }
  const subscribers = Object.entries(doc.subscribers || {}).filter(([, s]) => s.subscribed).map(([id]) => id).sort();
  return { nodeId: doc.nodeId, tags, comments: roots, commentCount: all.filter((c) => !c.deleted).length, subscribers };
}

function summariseReactions(reactions = {}) {
  const out = {};
  for (const [emoji, users] of Object.entries(reactions)) {
    const on = Object.entries(users).filter(([, r]) => r.on).map(([u]) => u);
    if (on.length) out[emoji] = on;
  }
  return out;
}

// Extract mentioned user ids from a body. Supports rich `@[Name](id)` tokens
// (from a mention picker) and bare `@handle` tokens (handy when the identity is
// an email/handle and there's no user directory — BYO-IdP deployments).
export function extractMentions(body) {
  const ids = new Set();
  let text = String(body || '');
  const rich = /@\[[^\]]+\]\(([^)]+)\)/g;
  let m;
  while ((m = rich.exec(text))) ids.add(m[1]);
  text = text.replace(rich, ' '); // remove rich tokens before scanning bare ones
  const bare = /(?:^|\s)@([a-zA-Z0-9._@-]{2,})/g;
  while ((m = bare.exec(text))) ids.add(m[1].replace(/[.@-]+$/, ''));
  return [...ids];
}
