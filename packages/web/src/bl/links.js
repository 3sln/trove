// Following a `trove:` link from a document.
//
// Resolution is deliberately lazy — at click time, not at render time. A document can
// hold dozens of links; resolving them all on every render would be a request per link,
// and the answer can change between renders anyway (the target may be created, renamed,
// or deleted while the document is open). So a link is rendered from its text alone, and
// only what the user actually follows costs a round trip.
//
// A broken link is a normal, expected state — names are the legible way to write a link,
// and renaming breaks them. It has to say so clearly, and say WHY, because "nothing
// happened" is the worst possible response to a click.

import { parseTroveUri } from '@trove/core/links.js';
import { OpenFileAction } from './actions.js';

/**
 * Open what a `trove:` URI points at.
 * @param {object} ui       the workbench ui helper
 * @param {string} uri      the link as written in the document
 * @param {{from?: object}} [opts]  the item the link was followed FROM, for messages
 */
export async function openTroveLink(ui, uri, { from } = {}) {
  const ref = parseTroveUri(uri);
  const notify = ui.platform.notifications;
  if (!ref) {
    notify.warn(`"${uri}" isn’t a valid Trove link.`);
    return null;
  }
  try {
    const res = await ui.platform.api.stat(uri);
    if (!res?.node) throw new Error('not found');
    ui.go(new OpenFileAction(res.node));
    return res.node;
  } catch (err) {
    notify.warn(describeBrokenLink(ref, err, from));
    return null;
  }
}

/**
 * Why a link didn't open, in terms of the link the user is looking at. A 403 is a
 * different situation from a 404 and must not be reported as one: "no such item" when
 * the item exists but isn't yours is both wrong and a small information leak in reverse.
 */
function describeBrokenLink(ref, err, from) {
  const where = from?.name ? ` (linked from "${from.name}")` : '';
  if (err?.status === 403 || err?.code === 'forbidden') {
    return `You don’t have access to that item in "${ref.collection}"${where}.`;
  }
  if (ref.by === 'name') {
    return `Nothing named "${ref.value}" in "${ref.collection}"${where} — it may have been renamed or deleted.`;
  }
  return `That item no longer exists in "${ref.collection}"${where}.`;
}
