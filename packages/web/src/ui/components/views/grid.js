// The grid view: tiles, with a picture on them where there is a picture to show.
//
// This is the second way to look at a drive, and it exists as much to prove the view
// contract as to be useful — a contribution type with one implementation is a guess. It
// draws the SAME groups the list does, headers and all, because the group header is
// where Upload, Empty trash and Retry live: a view that dropped it would take those off
// the screen the moment someone switched to tiles.
//
// On thumbnails, honestly: there is no thumbnail service yet, so a tile showing a
// photograph is showing the photograph, scaled down by the browser. That is affordable
// only because `loading="lazy"` means the ones below the fold are never fetched — the
// grid asks for what is on screen and nothing else. A hosted build that generates real
// thumbnails should register its own view rather than patch this one; that is the whole
// point of the contribution.

import { dd } from '../../../runtime.js';
import { icon, iconForNode } from '../../icon.js';
import { groupHeader, menuButton, openRowMenu } from './parts.js';
import { attachMedia } from '../../media.js';

const { div, span, img } = dd;

export function gridView({ groups, index, handlers, ui }) {
  let gi = -1;
  return div({ className: 'launch-view view-grid' },
    ...groups.map((group) => div({ className: 'launch-group' },
      groupHeader(group),
      group.items.length
        ? div({ className: 'grid-list' }, ...group.items.map((it) => {
          const at = ++gi;
          return tile(it, at === index, {
            hover: () => handlers.hover(at),
            select: () => handlers.select(at),
          }, ui);
        }))
        : div({ className: 'launch-empty' }, group.empty || 'Nothing here.'),
    )),
  );
}

/**
 * Which way to move for an arrow key.
 *
 * The launcher owns keyboard navigation and thinks in one flat list, which is right for
 * rows and wrong for tiles: down should mean the tile below, not the tile beside. The
 * view is asked, gets to answer in the launcher's own terms (a delta), and the launcher
 * keeps the wrapping, the selection and the scrolling.
 *
 * The column count is measured rather than assumed, because it comes from
 * `auto-fill` — it depends on the window width, the shell, and whether the sidebar
 * is open, none of which this file should be trying to predict.
 *
 * Left and right are only ours when the search box is empty. With a query typed in it,
 * those keys belong to the caret: someone fixing a typo must not find the highlight
 * walking across the grid instead.
 */
export function gridMove({ key, textual }) {
  if (key === 'ArrowLeft') return textual ? null : -1;
  if (key === 'ArrowRight') return textual ? null : 1;
  const cols = columns();
  if (key === 'ArrowUp') return -cols;
  if (key === 'ArrowDown') return cols;
  return null;
}

function columns() {
  // Tiles on the same row share an offsetTop. One row's worth is the answer; a grid with
  // a single row (or none on screen) falls back to 1, which is the list's behaviour and
  // never worse than a guess.
  const tiles = document.querySelectorAll('.grid-list .grid-tile');
  if (tiles.length < 2) return 1;
  const top = tiles[0].offsetTop;
  let n = 0;
  for (const el of tiles) {
    if (el.offsetTop !== top) break;
    n++;
  }
  return n || 1;
}

function tile(it, active, { hover, select }, ui) {
  const node = it.node;
  const pictorial = (node?.contentType || '').startsWith('image/');
  return div({ className: `grid-tile ${active ? 'active' : ''}`, title: it.detail ? `${it.title} — ${it.detail}` : it.title },
    div({ className: 'gt-media' },
      // The icon is drawn underneath, always. When the image loads it covers it; when
      // the image fails — a deleted object, a format the browser won't decode, a 401 —
      // hiding the <img> uncovers exactly what the list would have shown, rather than
      // leaving the browser's broken-image glyph in a gallery.
      icon(node ? iconForNode(node) : it.icon, { size: 26 }),
      // The `src` is minted rather than built — a tile fetches without our Authorization
      // header, so the URL has to carry its own grant. Minting is batched (see
      // platform/mediaUrls.js), so a wall of tiles costs one request, not one each.
      pictorial
        ? img({ className: 'gt-img', alt: '', loading: 'lazy', decoding: 'async' }).on({
          $attach: (dom) => {
            dom._detachMedia = attachMedia(dom, node, ui, {
              // Uncovering the icon underneath is exactly what the list would have shown,
              // and better than the browser's broken-image glyph in a gallery.
              onError: () => { dom.style.display = 'none'; },
            });
          },
          $detach: (dom) => { dom._detachMedia?.(); dom._detachMedia = null; },
        }).opaque()
        : null,
      it.badge ? span({ className: 'gt-badge' }, it.badge) : null,
      menuButton(it, ui, select),
    ),
    div({ className: 'gt-name' }, it.title),
  ).on({
    click: it.run,
    mouseenter: hover,
    ...(it.menu ? { contextmenu: (e) => { e.preventDefault(); openRowMenu(e.currentTarget, it, ui, e, select); } } : {}),
  });
}
