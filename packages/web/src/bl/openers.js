// Opener choice: which viewer opens a file when several can. Built-in and plugin
// openers register the same way (a selector + priority), so a file can match more
// than one — e.g. a plugin PDF viewer alongside a built-in, or a rich player vs the
// plain audio player for an .m4a. When that happens and the user hasn't expressed a
// preference, we ask; their choice can be remembered per file type.
//
// Preferences live in settings under `openers.associations`: a map from a *type key*
// (an extension like ".pdf", an exact mime, or a "type/*" wildcard) to an opener id.

import { selectorMatches } from '@3sln/trove/core/util.js';
import { extOf } from './fileType.js';

export const ASSOC_KEY = 'openers.associations';

export { extOf };

/**
 * One opener as the chooser and the switcher need to see it: what it is called, what it
 * claims, and where it came from.
 *
 * `source` is resolved here because it needs the plugin host to answer, which a component
 * has no business holding. `match` stays so the selector can be applied later, by
 * `openersFor`, against a node the caller already has.
 *
 * No `component`, only because nothing on this path renders — both callers are picking
 * between openers, not drawing with one. (A renderer would be fine to pass: it is a pure
 * vnode builder. See the `views` query, which does exactly that.)
 */
export function describeOpener(opener, plugins) {
  return {
    id: opener.id,
    title: opener.title ?? opener.name ?? opener.id,
    match: opener.match ?? null,
    priority: opener.priority ?? 0,
    pluginId: opener.pluginId ?? null,
    source: opener.pluginId
      ? (plugins?.plugins?.get(opener.pluginId)?.manifest?.displayName || opener.pluginId)
      : 'Built-in',
  };
}

/**
 * Which of these openers claim this node, best first.
 *
 * Pure, and deliberately so — see the `openers` query. Every reactive decision (when-clause,
 * plugin health, priority order) has already been made; all that is left is running a
 * selector over a file, which needs nothing but its two arguments.
 */
export function openersFor(openers, node) {
  return (openers || []).filter((o) => selectorMatches(o.match, node));
}

/** The canonical type key we remember a choice under: prefer extension, else mime. */
export function typeKeyFor(node) {
  return extOf(node) || node?.contentType || '';
}

/** A human label for the type, for "Always use … for {label}". */
export function typeLabelFor(node) {
  const ext = extOf(node);
  if (ext) return `${ext} files`;
  const mime = node?.contentType || '';
  return mime ? `${mime} files` : 'this file type';
}

/**
 * All openers that can handle this node right now (selector + when + availability),
 * best (highest priority) first — for an ACTION, which holds the resources to ask.
 *
 * The render layer gets the same answer the other way round: the `openers` query resolves
 * when/availability, `openersFor` applies the selector. Both end at `describeOpener`, so
 * the opener-chooser dialog looks the same whichever side opened it.
 */
export function availableOpeners(r, node) {
  return r.contributions
    .openersFor(node)
    .filter((o) => (!o.when || r.context.evaluate(o.when)) && r.plugins.isAvailable(o))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .map((o) => describeOpener(o, r.plugins));
}

/** The remembered opener id for a node's type (ext → exact mime → type/* ), or null. */
export function rememberedOpenerId(r, node) {
  const assoc = r.settings.get(ASSOC_KEY) || {};
  const ext = extOf(node);
  const mime = node?.contentType || '';
  const wild = mime.includes('/') ? `${mime.slice(0, mime.indexOf('/') + 1)}*` : '';
  return (ext && assoc[ext]) || (mime && assoc[mime]) || (wild && assoc[wild]) || null;
}

/**
 * The associations with one type key changed, or removed with a null openerId.
 *
 * Returns the next map rather than writing it: the write is `RememberOpenerAction`'s, and
 * keeping the arithmetic separate from the effect is what lets both the settings screen and
 * the opener chooser reach it without either touching `settings`.
 */
/**
 * WHY A STALE ASSOCIATION IS KEPT rather than cleared on uninstall.
 *
 * Nothing deletes these when a plugin goes, and that is deliberate. Two places already
 * make it safe: `OpenFileAction` honours a remembered opener only if it is still
 * AVAILABLE, and `openerAssociations` marks a row `missing` so the settings screen says
 * the opener is gone rather than showing a bare id.
 *
 * Keeping it is the better behaviour — reinstalling the plugin restores the preference,
 * and deleting it eagerly would discard a choice on an action (uninstall) that says
 * nothing about file associations. It can still be dropped on purpose, through this
 * function with a null openerId.
 *
 * See opener-association.test.js: this is correct in two places at once, neither obvious
 * from the other, which is the kind of thing that gets tidied into a bug.
 */
export function withAssociation(assoc, typeKey, openerId) {
  const next = { ...(assoc || {}) };
  if (openerId) next[typeKey] = openerId;
  else delete next[typeKey];
  return next;
}
