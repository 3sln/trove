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

import { Action } from '@3sln/ngin';
import { parseTroveUri } from '@3sln/trove/core/links.js';
import { runAction } from '../dispatch.js';
import { OpenFileAction } from './actions.js';

/**
 * Open what a `trove:` URI points at.
 *
 * An ACTION, because it is a network stat, a choice between three failure messages, and an
 * open. It was a plain function taking the UI bag — the only module in bl/ whose parameter
 * was a UI-layer shape, reaching `ui.platform.api` and `ui.engine` to do all of that with
 * no lease on anything and nothing of it on the feed. pluginHost.js states the rule for the
 * same kind of edge: "Dispatched, not called: opening a file from a docked plugin frame is
 * the same intent as opening one from the drive, and the engine should see both."
 *
 * The laziness the module header argues for is untouched — this still runs at click time,
 * and where the work runs was never what that argument was about.
 */
export class OpenTroveLinkAction extends Action {
  static deps = ['api', 'engine', 'notifications'];

  /** @param {string} uri the link as written; @param {object} [from] the item it was in */
  constructor(uri, from = null) { super(); this.uri = uri; this.from = from; }

  async execute({ api, engine, notifications }) {
    const ref = parseTroveUri(this.uri);
    if (!ref) {
      notifications.warn(`"${this.uri}" isn’t a valid Trove link.`);
      return;
    }
    try {
      const res = await api.stat(this.uri);
      if (!res?.node) throw new Error('not found');
      await runAction(engine, new OpenFileAction(res.node));
    } catch (err) {
      notifications.warn(describeBrokenLink(ref, err, this.from));
    }
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
