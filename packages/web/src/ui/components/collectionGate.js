// The only thing on screen until a collection is chosen.
//
// Every collection-scoped request names its collection in the path, so before one is
// known there is no file list to draw, nothing to search, and nowhere to upload to. The
// old behaviour was to pick something — the remembered one, else `default`, else the
// first in the list — and that is exactly the guess this replaces: on a shared drive it
// opened a collection plenty of people could not read, and presented the permission error
// as their drive.
//
// So there are two questions and no guesses. A drive with nothing in it asks for a
// collection to be made; a drive with several asks which one. Once answered, the choice is
// remembered in localStorage and this never appears again.

import { dd } from '../../runtime.js';
import { icon } from '../icon.js';

const { div, h2, p, button, span } = dd;

export default function collectionGate(state, ui) {
  const ex = state.ex || {};
  return div({ className: 'editor' },
    div({ className: 'stage' },
      div({ className: 'gate' },
        ex.gate === 'create' ? createPrompt(ui) : choosePrompt(ex, ui),
      ),
    ),
  );
}

/**
 * A drive with no collections at all.
 *
 * Only shown to someone who may actually create one — `OpenInitialCollectionAction`
 * sends everyone else to the "ask an administrator" message instead, because inviting
 * someone to do a thing they are not allowed to do is worse than saying nothing.
 */
function createPrompt(ui) {
  return div({ className: 'gate-card' },
    div({ className: 'gate-icon' }, icon('files', { size: 26 })),
    h2('Make your first collection'),
    p({ className: 'gate-sub' },
      'A collection is a backing store you own — a bucket, a directory, a mount. Files '
      + 'live in one, and permissions are granted on one. Nothing can be uploaded until '
      + 'there is somewhere to put it.'),
    div({ className: 'gate-actions' },
      button({ className: 'btn primary' }, icon('plus', { size: 14 }), 'New collection')
        .on({ click: () => ui.exec('collections.create') }),
    ),
  );
}

/** Collections exist, but the user has not said which one they want. */
function choosePrompt(ex, ui) {
  const collections = ex.collections || [];
  return div({ className: 'gate-card' },
    div({ className: 'gate-icon' }, icon('grid', { size: 26 })),
    h2(collections.length === 1 ? 'Open your collection' : 'Choose a collection'),
    p({ className: 'gate-sub' },
      collections.length === 1
        ? 'This is the one you have access to. Opening it will be remembered for next time.'
        : 'Files, search and uploads all belong to one collection. Your choice is remembered '
          + 'for next time, and you can switch from the status bar whenever you like.'),
    div({ className: 'gate-list' },
      ...collections.map((c) => button({ className: 'gate-choice' },
        div({ className: 'gate-choice-main' },
          span({ className: 'n' }, c.name || c.id),
          span({ className: 'd' }, c.driver ? `${c.driver}${c.description ? ` · ${c.description}` : ''}` : (c.description || '')),
        ),
        // What they may do, from the server's own answer — so a read-only collection says
        // so before they open it and find the Upload button missing.
        span({ className: 'gate-caps' }, (c.capabilities || []).join(' · ')),
      ).on({ click: () => ui.exec('collections.switch', c.id) })),
    ),
    ex.canCreateCollection
      ? div({ className: 'gate-actions' },
        button({ className: 'btn' }, icon('plus', { size: 14 }), 'New collection')
          .on({ click: () => ui.exec('collections.create') }),
      )
      : null,
  );
}
