import { dd } from '../../runtime.js';
import { icon, iconForNode } from '../icon.js';
import { SearchAction, OpenFileAction } from '../../bl/actions.js';

const { div, input, button, span, p } = dd;

const MODES = [
  { id: 'hybrid', label: 'Hybrid' },
  { id: 'semantic', label: 'Semantic' },
  { id: 'keyword', label: 'Keyword' },
];

export default function searchView(state, ui) {
  const se = state.se;
  return div({ className: 'sidebar' },
    div({ className: 'head' }, span('Search')),
    div({ className: 'searchview' },
      div({ className: 'box' },
        input({
          className: 'input', type: 'search', placeholder: 'Search by meaning or keyword…',
          value: se.query, autofocus: true,
        }).on({
          input: (e) => debounceSearch(ui, e.target.value, se.mode),
          keydown: (e) => { if (e.key === 'Enter') ui.go(new SearchAction(e.target.value, se.mode)); },
        }),
      ),
      div({ className: 'modes' },
        ...MODES.map((m) =>
          button({ className: `chip ${se.mode === m.id ? 'active' : ''}` }, m.label)
            .on({ click: () => ui.go(new SearchAction(se.query, m.id)) }),
        ),
      ),
      results(se, ui),
    ),
  );
}

function results(se, ui) {
  if (se.loading) return div({ className: 'empty' }, div({ className: 'spinner' }), span('Searching…'));
  if (se.error) return div({ className: 'empty' }, icon('warn', { size: 26 }), span(se.error));
  if (!se.ran) {
    return div({ className: 'empty' },
      icon('search', { size: 30 }),
      p('Find files by what they mean, not just their name.'),
      p({ className: 'hint', $styling: { fontSize: '12px', color: 'var(--text-faint)' } }, 'Try "invoices from last spring" or "that photo of a dog".'),
    );
  }
  if (!se.results.length) return div({ className: 'empty' }, span('No matches.'));
  return div({ className: 'results' }, ...se.results.map((r) => result(r, ui)));
}

function result(r, ui) {
  const node = r.node;
  const pct = Math.round((r.score || 0) * 100);
  return div({ className: 'result' },
    div({ className: 'top' },
      icon(iconForNode(node), { size: 15 }),
      span({ className: 'name' }, node.name),
      r.indexerId && r.indexerId !== 'core.name' ? span({ className: 'badge' }, r.indexerId.replace(/^core\./, '')) : null,
      span({ className: 'score' }, `${pct}%`),
    ),
    div({ className: 'path' }, node.path),
    r.snippet ? div({ className: 'snippet' }, highlight(r.snippet, ui.app.search.state.query)) : null,
  ).on({ click: () => ui.go(new OpenFileAction(node)) });
}

// Wrap query terms in <mark>. Returns an array of vnodes/strings.
function highlight(text, query) {
  const terms = (query || '').toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return [text];
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi');
  const parts = text.split(re);
  return parts.map((part) => (re.test(part) && terms.includes(part.toLowerCase()) ? dd.mark(part) : part));
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let timer = null;
function debounceSearch(ui, query, mode) {
  ui.app.search.set({ query });
  clearTimeout(timer);
  timer = setTimeout(() => ui.go(new SearchAction(query, mode)), 280);
}
