// Command palette + quick-open. Mode 'commands' fuzzy-filters registered
// commands (respecting when-clauses); mode 'files' searches the drive by name
// and opens the chosen file. Arrow keys move, Enter runs, Esc closes.

import { dd } from '../../runtime.js';
import { icon, iconForNode } from '../icon.js';
import { prettyKey } from '../../platform/keybindings.js';
import { OpenFileAction } from '../../bl/actions.js';

const { div, input, span } = dd;

export default function commandPalette(state, ui) {
  const pal = state.wb.palette;
  if (!pal) return null;
  const wb = ui.platform.workbench;
  const items = pal.mode === 'files' ? ui._paletteFiles || [] : filterCommands(state, ui, pal.query);
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
          input: (e) => onQuery(ui, pal.mode, e.target.value),
          keydown: (e) => onKey(e, ui, items, index, run),
          $attach: (el) => queueMicrotask(() => el.focus()),
        }),
      ),
      div({ className: 'results' },
        items.length
          ? items.map((item, i) => (pal.mode === 'files' ? fileOpt(item, i === index, run) : cmdOpt(item, i === index, ui, run)))
          : div({ className: 'none' }, pal.mode === 'files' ? 'No files found' : 'No matching commands'),
      ),
    ),
  );
}

function cmdOpt(cmd, active, ui, run) {
  const key = ui.platform.keybindings.labelFor(cmd.id);
  const available = ui.platform.commands.isAvailable(cmd);
  return div({ className: `opt ${active ? 'active' : ''} ${available ? '' : 'unavailable'}` },
    span({ className: 'ico' }, icon(cmd.icon || 'command', { size: 16 })),
    cmd.category ? span({ className: 'cat' }, cmd.category + ' ›') : null,
    span({ className: 'title' }, cmd.title),
    !available ? span({ className: 'offline-tag' }, 'offline') : null,
    key ? span({ className: 'kbd' }, dd.h('kbd', prettyKey(keyRaw(ui, cmd.id)))) : null,
  ).on({ click: () => run(cmd) });
}

function keyRaw(ui, id) {
  const b = ui.platform.keybindings.resolved().find((x) => x.command === id);
  return b ? b.key : '';
}

function fileOpt(item, active, run) {
  return div({ className: `opt ${active ? 'active' : ''}` },
    span({ className: 'ico' }, icon(iconForNode(item.node), { size: 16 })),
    span({ className: 'title' }, item.node.name),
    span({ className: 'sub' }, item.node.path),
  ).on({ click: () => run(item) });
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
function onQuery(ui, mode, value) {
  ui.platform.workbench.setPaletteQuery(value);
  if (mode !== 'files') return;
  clearTimeout(fileTimer);
  fileTimer = setTimeout(async () => {
    const q = value.trim();
    if (!q) {
      ui._paletteFiles = [];
      ui.rerender?.();
      return;
    }
    try {
      const res = await ui.platform.api.search(q, { mode: 'keyword', limit: 30 });
      ui._paletteFiles = res.results.filter((r) => r.node.kind === 'file');
      ui.rerender?.();
    } catch { /* ignore */ }
  }, 200);
}
