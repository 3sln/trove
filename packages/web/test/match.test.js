// Ranking what someone typed, and classifying what a signature means.
//
// Both of these existed TWICE, in two components, with two different answers. The tests
// that matter here are the ones that would have caught that: same input, one answer.

import { test, expect } from './testkit.js';
import { matchScore, rankCommands } from '../src/bl/match.js';
import { describeTrust } from '../src/bl/trust.js';
import { parseMentions } from '../src/bl/mentions.js';

const CMDS = [
  { id: 'workbench.showCommandPalette', title: 'Show All Commands', category: 'View' },
  { id: 'workbench.quickOpen', title: 'Go to File…', category: 'File' },
  { id: 'workbench.openSettings', title: 'Open Settings', category: 'Preferences' },
  { id: 'explorer.refresh', title: 'Refresh', category: 'Explorer' },
  { id: 'explorer.delete', title: 'Delete', category: 'Explorer' },
];
const titles = (term) => rankCommands(CMDS, term).map((c) => c.title);

test('the letters must appear in order, or it is not a match at all', () => {
  expect(matchScore('open settings', 'ops')).toBeGreaterThan(0);
  // Same letters, wrong order.
  expect(matchScore('open settings', 'spo')).toBe(0);
  expect(matchScore('open settings', 'zzz')).toBe(0);
  // An empty term matches everything, which is what makes an empty palette show the list.
  expect(matchScore('anything', '')).toBe(1);
});

test('a contiguous run beats scattered letters, and an earlier one beats a later one', () => {
  // "set" is contiguous in both, but starts earlier in Settings.
  expect(matchScore('settings', 'set')).toBeGreaterThan(matchScore('reset', 'set'));
  // Contiguous beats a subsequence spread across the string.
  expect(matchScore('delete', 'del')).toBeGreaterThan(matchScore('duplicate element', 'del'));
});

test('typing a command name ranks it first', () => {
  expect(titles('delete')[0]).toBe('Delete');
  expect(titles('refresh')[0]).toBe('Refresh');
  // By category, because someone typing a category means the things in it.
  expect(titles('explorer')).toContain('Delete');
  expect(titles('explorer')).toContain('Refresh');
});

test('nothing matching is an empty list, not the whole list', () => {
  expect(rankCommands(CMDS, 'zzzzz')).toEqual([]);
  // But an empty term is not "nothing matching" — it is "no opinion".
  expect(rankCommands(CMDS, '').length).toBe(CMDS.length);
  expect(rankCommands(CMDS, '   ').length).toBe(CMDS.length);
});

test('ties are broken by title, so the order is stable rather than registration order', () => {
  const same = [
    { id: 'b', title: 'Zebra', category: 'X' },
    { id: 'a', title: 'Antelope', category: 'X' },
  ];
  expect(rankCommands(same, 'x').map((c) => c.title)).toEqual(['Antelope', 'Zebra']);
});

test('it survives being handed nothing', () => {
  expect(rankCommands(null, 'x')).toEqual([]);
  expect(rankCommands(undefined, '')).toEqual([]);
});

// --- trust ------------------------------------------------------------------------
//
// The distinction this exists to protect: `invalid` means the package was signed and the
// signature does not verify — someone altered it. `unverified` means nobody signed it,
// which is ordinary. The installed-plugins list once rendered the first as the second,
// because the two components classified separately and one was missing the branch.

test('an invalid signature is never classified as merely unsigned', () => {
  const invalid = describeTrust({ status: 'invalid' });
  const unverified = describeTrust({ status: 'unverified' });
  expect(invalid.status).toBe('invalid');
  expect(invalid.tone).not.toBe(unverified.tone);
  // And it must read as the more serious of the two, whichever way a surface sorts them.
  expect(invalid.severity).toBeGreaterThan(unverified.severity);
  expect(invalid.explanation).toContain('altered');
});

test('every state is classified, including ones nobody thought of', () => {
  for (const status of ['verified', 'signed', 'invalid', 'unverified']) {
    expect(describeTrust({ status }).status).toBe(status);
  }
  // A package whose trust could not be assessed at all is unverified, not a crash — and
  // definitely not verified.
  for (const t of [null, undefined, {}, { status: 'something-new' }]) {
    expect(describeTrust(t).status).toBe('unverified');
  }
});

test('a verified badge says who vouched, and falls back rather than saying "undefined"', () => {
  expect(describeTrust({ status: 'verified', domain: 'acme.com' }).explanation).toContain('acme.com');
  expect(describeTrust({ status: 'verified' }).explanation).not.toContain('undefined');
});

test('a reason from the verifier is preferred over the generic explanation', () => {
  const t = describeTrust({ status: 'invalid', reason: 'digest mismatch on entry 3' });
  expect(t.explanation).toBe('digest mismatch on entry 3');
});

// --- mentions -----------------------------------------------------------------------
//
// The sibling of bl/tagQuery.js. It lived in the social component as a regex splitting a
// text format mid-render.

test('both spellings of a mention are found, and nothing else is', () => {
  const parts = parseMentions('hi @[Ada Lovelace](u_1) and @bob, see a@b.com');
  const names = parts.filter((p) => p.type === 'mention').map((p) => p.name);
  expect(names).toEqual(['Ada Lovelace', 'bob']);
  // An email address is not a mention — the bare form needs whitespace (or a line start)
  // in front of the `@`, which is what keeps "a@b.com" intact.
  expect(parts.map((p) => p.value || '').join('')).toContain('a@b.com');
});

test('the resolved form carries the id, the bare form does not', () => {
  const [m] = parseMentions('@[Ada](u_1)').filter((p) => p.type === 'mention');
  expect(m.id).toBe('u_1');
  const [b] = parseMentions('hi @bob').filter((p) => p.type === 'mention');
  expect(b.id).toBe(null);
});

test('the text either side of a mention survives intact', () => {
  expect(parseMentions('before @bob after').map((p) => p.value ?? `@${p.name}`).join(''))
    .toBe('before @bob after');
  // A body with no mentions at all is one run of text, not an empty list.
  expect(parseMentions('nothing here')).toEqual([{ type: 'text', value: 'nothing here' }]);
  expect(parseMentions('')).toEqual([]);
  expect(parseMentions(null)).toEqual([]);
});

test('parsing twice gives the same answer', () => {
  // The regex is built per call. A shared /g one keeps `lastIndex` between calls, so the
  // second parse of the same body would start halfway through it.
  const body = 'hi @bob and @[Ada](u_1)';
  expect(parseMentions(body)).toEqual(parseMentions(body));
});
