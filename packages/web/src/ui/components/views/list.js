// The list view: one row per item, which is what a drive looks like unless you ask
// for something else.
//
// It is also the fallback for every other view: one that throws lands here, and views
// are host code with no sandbox to catch them first. So it must not depend on anything
// beyond the contract itself — no settings, no capabilities, no network.

import { dd } from '../../../runtime.js';
import { icon } from '../../icon.js';
import { groupHeader, menuButton, openRowMenu } from './parts.js';

const { div, span } = dd;

export function listView({ groups, index, handlers, ui }) {
  let gi = -1;
  return div({ className: 'launch-view view-list' },
    ...groups.map((group) => div({ className: 'launch-group' },
      groupHeader(group),
      group.items.length
        ? div({ className: 'launch-list' }, ...group.items.map((it) => {
          const at = ++gi;
          return itemRow(it, at === index, {
            hover: () => handlers.hover(at),
            select: () => handlers.select(at),
          }, ui);
        }))
        : div({ className: 'launch-empty' }, group.empty || 'Nothing here.'),
    )),
  );
}

function itemRow(it, active, { hover, select }, ui) {
  return div({ className: `launch-item ${active ? 'active' : ''}` },
    icon(it.icon, { size: 15 }),
    span({ className: 'name' }, it.title),
    it.detail ? span({ className: 'launch-detail' }, it.detail) : null,
    it.badge ? span({ className: 'launch-kind' }, it.badge) : null,
    // Everything you can do to a file, on the file. Rename, download, copy link and
    // delete were all commands with no way to reach them: the palette's versions act on
    // "the selection", and until the highlight became a selection there never was one.
    menuButton(it, ui, select),
  // One `.on()` call: a second replaces the handler map rather than merging into it,
  // which is how adding `contextmenu` silently removed `click` and stopped every file
  // in the drive from opening.
  ).on({
    click: it.run,
    mouseenter: hover,
    ...(it.menu ? { contextmenu: (e) => { e.preventDefault(); openRowMenu(e.currentTarget, it, ui, e, select); } } : {}),
  });
}
