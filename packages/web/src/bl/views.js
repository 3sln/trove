// Which of the registered views should draw the results.
//
// The reactive half — which views exist, their when-clauses, which one the user pinned —
// is the `views` query. This is the rest: arithmetic over the items on screen.
//
// Still a plain function rather than part of that query only because the launcher assembles
// the items mid-render. They are themselves derived from the explorer and search state, so
// this folds into a query as soon as that assembly does.
//
// It lived in ui/components/views/index.js, which was half a job: the registry reads moved
// into the engine and the DECISION stayed in the render layer. Choosing a layout from what
// a collection contains is a claim about the drive, not about markup.

/** Where a pinned view choice is remembered. */
export const SETTING = 'explorer.view';

/**
 * The view to draw with, in order of how much someone meant it.
 *
 * 1. A saved choice — they pressed a button. Nothing infers its way past that.
 * 2. The search transformer's hint, when there is a search on screen. It read the
 *    sentence: "photos from the trip last summer" is a request for a gallery as much as
 *    it is a query, and nothing downstream can recover that from a list of content types.
 * 3. A view whose `match` suits what is actually there — a collection of photographs
 *    opens as a grid without anyone asking.
 * 4. The highest priority, which is the list.
 *
 * A hint naming a view this build doesn't have is ignored, not an error: the transformer
 * is deployment configuration and may outlive the build it was written against.
 *
 * PURE. It used to take `platform` and read the contribution registry, the context keys and
 * the settings mid-render — three reads that nothing invalidated on, so the launcher only
 * kept up because the shell's snapshot was coarse enough to redraw it anyway. The reactive
 * half is the `views` query now; what is left is arithmetic over the items already on
 * screen, which is the one input that cannot be a query (there is no sensible key for "these
 * forty search results").
 *
 * @param {{views: Array, saved: string|null}} slice from the `views` query
 * @param {Array} items the rows being drawn, `{ node }`-shaped
 * @param {string|null} hint the search transformer's suggestion, if this is a search
 */
export function pickView({ views = [], saved = null } = {}, items = [], hint = null) {
  if (!views.length) return null;
  const chosen = saved && views.find((v) => v.id === saved);
  if (chosen) return chosen;
  const suggested = hint && views.find((v) => v.id === hint);
  if (suggested) return suggested;
  const nodes = items.map((i) => i.node).filter(Boolean);
  if (nodes.length >= 3) {
    const suits = (v) => v.match && Object.keys(v.match).length
      && nodes.filter((n) => matchesView(v, n)).length / nodes.length > 0.6;
    const fitted = views.find(suits);
    if (fitted) return fitted;
  }
  return views[0];
}

function matchesView(view, node) {
  const ct = node.contentType || '';
  const name = (node.name || '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  if ((view.match.ext || []).includes(ext)) return true;
  return (view.match.mime || []).some((m) => (m.endsWith('/*') ? ct.startsWith(m.slice(0, -1)) : ct === m));
}
