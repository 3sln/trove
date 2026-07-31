// Ranking what someone typed against a list of things.
//
// There were two of these, for one question. The command palette scored per matched
// character and added 10 for a contiguous substring; the launcher's `!` mode returned
// `1000 - index` for a substring and a flat 1 otherwise. So typing the same three letters
// ranked the same commands differently depending on which way you had reached them — and
// the launcher's version could not distinguish two commands that both merely contained the
// letters, because every non-substring match scored exactly 1.
//
// Neither was wrong so much as unaware of the other. Ranking is a decision about the
// drive's own vocabulary, so it belongs here, once.

/**
 * How well `hay` matches `term`. 0 means no match at all.
 *
 * Subsequence first — the letters must appear in order, which is what makes "cmp" find
 * "Command Palette". Then three things push a better match up:
 *
 *   - a contiguous substring beats scattered letters, by a lot
 *   - an earlier hit beats a later one, so typing "set" prefers "Settings" to "Reset"
 *   - adjacent letters beat gaps, which is the difference between "op" matching "Open" and
 *     matching "Only Photographs"
 *
 * @param {string} hay already lowercased
 * @param {string} term already lowercased and trimmed
 */
export function matchScore(hay, term) {
  if (!term) return 1;
  let score = 0;
  let from = 0;
  for (const ch of term) {
    const at = hay.indexOf(ch, from);
    if (at < 0) return 0; // not a subsequence — not a match
    score += at === from ? 3 : 1; // adjacency is worth more than mere presence
    from = at + 1;
  }
  const sub = hay.indexOf(term);
  if (sub >= 0) {
    // A contiguous run is the strongest signal there is, and the earlier it starts the
    // more likely it is what was meant.
    score += 100 - Math.min(50, sub);
  }
  return score;
}

/**
 * Commands matching `term`, best first.
 *
 * The haystack is "category title" because someone typing "view" means the View category
 * as readily as they mean a command with View in its name.
 *
 * @param {Array<{id: string, title: string, category?: string}>} commands
 * @param {string} term what was typed, without any leading `!`
 * @param {number} [limit]
 */
export function rankCommands(commands, term, limit = 60) {
  const q = (term || '').trim().toLowerCase();
  const all = commands || [];
  if (!q) return all.slice(0, limit);
  const scored = [];
  for (const c of all) {
    const s = matchScore(`${c.category || ''} ${c.title}`.toLowerCase(), q);
    if (s > 0) scored.push([s, c]);
  }
  // Ties break by title, so a list that cannot decide is at least stable rather than
  // ordered by whatever registered first.
  return scored
    .sort((a, b) => b[0] - a[0] || String(a[1].title).localeCompare(String(b[1].title)))
    .slice(0, limit)
    .map(([, c]) => c);
}
