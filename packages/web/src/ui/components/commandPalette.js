// Command palette + quick-open. Mode 'commands' fuzzy-filters registered
// commands (respecting when-clauses); mode 'files' searches the drive by name
// and opens the chosen file. Arrow keys move, Enter runs, Esc closes.

import { dd } from '../../runtime.js';
import { icon, iconForNode } from '../icon.js';
import { prettyKey } from '../../platform/keybindings.js';
import { OpenFileAction, QuickOpenAction } from '../../bl/actions.js';

const { div, input, span } = dd;

export default function commandPalette(state, ui) {
  const pal = state.overlay.palette;
  if (!pal) return null;
  const wb = ui.platform.workbench;
  // With no query there is nothing to show — and showing the PREVIOUS session's hits
  // would be worse than nothing, since they don't match what the field now says.
  const items = pal.mode === 'files'
    ? (pal.query.trim() ? state.se.paletteFiles || [] : [])
    : filterCommands(state, ui, pal.query);
  const index = Math.min(pal.index, Math.max(0, items.length - 1));

  const run = (item) => {
    if (!item) return;
    wb.closePalette();
    if (pal.mode === 'files') ui.go(new OpenFileAction(item.node));
    else ui.exec(item.id);
  };

  return div({},
    div({ className: 'scrim' }).on({ click: () => wb.closePalette() }),
    div({ className: 'palette' },
      div({ className: 'search' },
        icon(pal.mode === 'files' ? 'search' : 'command', { size: 18 }),
        input({
          type: 'text', value: pal.query, autofocus: true,
          placeholder: pal.mode === 'files' ? 'Search files by name…' : 'Type a command…',
        }).on({
          // NOTE: the mode is read from live state inside onQuery, NOT captured here.
          // A listener belongs to the render that created it, and rendering is async —
          // a keystroke landing between `openPalette('files')` and the re-render would
          // otherwise be handled as a COMMANDS keystroke and silently do nothing.
          input: (e) => onQuery(ui, e.target.value),
          keydown: (e) => onKey(e, ui, items, index, run),
          $attach: (el) => {
            queueMicrotask(() => el.focus());
            // Same reason in reverse: dodo only patches `value` when the vnode prop
            // changed, so a reopened palette whose query is '' both times would keep
            // whatever text the previous session left in the live DOM node.
            if (el.value !== pal.query) el.value = pal.query;
          },
        }),
      ),
      div({ className: 'results' },
        items.length
          ? items.map((item, i) => {
            const hover = () => wb.setPaletteIndex(i);
            return pal.mode === 'files' ? fileOpt(item, i === index, run, hover) : cmdOpt(item, i === index, ui, run, hover);
          })
          : emptyResults(pal, state),
      ),
    ),
  );
}

// Nothing to show is three different situations, and saying "No files found" for all
// three tells the user something false in two of them.
function emptyResults(pal, state) {
  if (pal.mode !== 'files') return div({ className: 'none' }, 'No matching commands');
  if (state.se.paletteError) return div({ className: 'none error' }, icon('warn', { size: 14 }), ` ${state.se.paletteError}`);
  if (state.se.paletteLoading) return div({ className: 'none' }, div({ className: 'spinner' }), ' Searching…');
  return div({ className: 'none' }, pal.query.trim() ? 'No files found' : 'Type to search files by name');
}

function cmdOpt(cmd, active, ui, run, hover) {
  const key = ui.platform.keybindings.labelFor(cmd.id);
  const available = ui.platform.commands.isAvailable(cmd);
  return div({ className: `opt ${active ? 'active' : ''} ${available ? '' : 'unavailable'}` },
    span({ className: 'ico' }, icon(cmd.icon || 'command', { size: 16 })),
    cmd.category ? span({ className: 'cat' }, cmd.category + ' ›') : null,
    span({ className: 'title' }, cmd.title),
    !available ? span({ className: 'offline-tag' }, 'offline') : null,
    key ? span({ className: 'kbd' }, dd.h('kbd', prettyKey(keyRaw(ui, cmd.id)))) : null,
  ).on({ click: () => run(cmd), mouseenter: hover });
}

function keyRaw(ui, id) {
  const b = ui.platform.keybindings.resolved().find((x) => x.command === id);
  return b ? b.key : '';
}

function fileOpt(item, active, run, hover) {
  return div({ className: `opt ${active ? 'active' : ''}` },
    span({ className: 'ico' }, icon(iconForNode(item.node), { size: 16 })),
    span({ className: 'title' }, item.node.name),
    span({ className: 'sub' }, item.node.contentType || ''),
  ).on({ click: () => run(item), mouseenter: hover });
}

function filterCommands(state, ui, query) {
  const all = ui.platform.commands.paletteCommands();
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, 60);
  const scored = [];
  for (const c of all) {
    const hay = `${c.category || ''} ${c.title}`.toLowerCase();
    const s = fuzzyScore(hay, q);
    if (s > 0) scored.push([s, c]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, 60).map((x) => x[1]);
}

function fuzzyScore(hay, q) {
  let score = 0;
  let hi = 0;
  for (const ch of q) {
    const idx = hay.indexOf(ch, hi);
    if (idx < 0) return 0;
    score += idx === hi ? 3 : 1;
    hi = idx + 1;
  }
  if (hay.includes(q)) score += 10;
  return score;
}

function onKey(e, ui, items, index, run) {
  const wb = ui.platform.workbench;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    wb.movePalette(1, items.length);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    wb.movePalette(-1, items.length);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    run(items[index]);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    wb.closePalette();
  }
}

let fileTimer = null;
function onQuery(ui, value) {
  const wb = ui.platform.workbench;
  wb.setPaletteQuery(value);
  // The palette's CURRENT mode, not whichever one was on screen when this listener
  // was created — see the note at the input.
  clearTimeout(fileTimer);
  if (wb.overlay.state.palette?.mode !== 'files') return;
  // Route the file search through an action; results land in the reactive search
  // service (state.se.paletteFiles), so the palette re-renders without ad-hoc state.
  fileTimer = setTimeout(() => ui.go(new QuickOpenAction(value)), 200);
}
