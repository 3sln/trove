// Opener choice: which viewer opens a file when several can. Built-in and plugin
// openers register the same way (a selector + priority), so a file can match more
// than one — e.g. a plugin PDF viewer alongside a built-in, or a rich player vs the
// plain audio player for an .m4a. When that happens and the user hasn't expressed a
// preference, we ask; their choice can be remembered per file type.
//
// Preferences live in settings under `openers.associations`: a map from a *type key*
// (an extension like ".pdf", an exact mime, or a "type/*" wildcard) to an opener id.

import { extOf } from './fileType.js';

const ASSOC_KEY = 'openers.associations';

export { extOf };

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

/** All openers that can handle this node right now (selector + when + availability),
 *  best (highest priority) first. */
export function availableOpeners(platform, node) {
  const evaluate = (w) => platform.context.evaluate(w);
  const isAvailable = (o) => platform.plugins.isAvailable(o);
  return platform.contributions
    .openersFor(node)
    .filter((o) => (!o.when || evaluate(o.when)) && isAvailable(o))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

/** The remembered opener id for a node's type (ext → exact mime → type/* ), or null. */
export function rememberedOpenerId(platform, node) {
  const assoc = platform.settings.get(ASSOC_KEY) || {};
  const ext = extOf(node);
  const mime = node?.contentType || '';
  const wild = mime.includes('/') ? `${mime.slice(0, mime.indexOf('/') + 1)}*` : '';
  return (ext && assoc[ext]) || (mime && assoc[mime]) || (wild && assoc[wild]) || null;
}

/** Remember (or, with a null openerId, forget) the opener for a type key. */
export function rememberOpener(platform, typeKey, openerId) {
  if (!typeKey) return;
  const assoc = { ...(platform.settings.get(ASSOC_KEY) || {}) };
  if (openerId) assoc[typeKey] = openerId;
  else delete assoc[typeKey];
  platform.settings.set(ASSOC_KEY, assoc);
}

/** The saved associations as a list, for the Settings UI. */
export function listAssociations(platform) {
  const assoc = platform.settings.get(ASSOC_KEY) || {};
  return Object.entries(assoc).map(([typeKey, openerId]) => {
    const opener = platform.contributions.get(openerId);
    return { typeKey, openerId, openerTitle: opener?.title || openerId, missing: !opener };
  });
}

/** A short source label for an opener ("Built-in" or the plugin's name). */
export function openerSource(platform, opener) {
  if (!opener?.pluginId) return 'Built-in';
  return platform.plugins.plugins.get(opener.pluginId)?.manifest?.displayName || opener.pluginId;
}
