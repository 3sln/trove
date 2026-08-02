// Per-item, per-plugin key/value data — and the merge that lets two devices both write it.
//
// This is where a viewer keeps state that belongs to the USER and the ITEM together: an
// audiobook's listening position, a reader's last page. Not an indexer contribution —
// those are derived from the file and rewritten whenever it is re-indexed — and not a
// setting, because settings are per-device and a position that does not follow you to
// your phone is the one people notice missing.
//
// It rides the sidecar because the sidecar is already a per-item CRDT with an LWW
// register and a merge. The only new thing is a scope.

import { test, expect } from 'bun:test';
import { emptyDoc, setData, removeData, dataOf, mergeDoc, setTag } from '../src/sidecar/document.js';

const AUDIO = 'trove+plugin:3sln.com/audiobook';
const READER = 'trove+plugin:acme.com/reader';

test('a plugin reads back what it wrote, as plain values', () => {
  const doc = emptyDoc('itm_1');
  setData(doc, AUDIO, 'position', 1234.5, { actor: 'alice' });
  setData(doc, AUDIO, 'finished', false, { actor: 'alice' });
  expect(dataOf(doc, AUDIO)).toEqual({ position: 1234.5, finished: false });
});

test('scopes do not see each other', () => {
  // The reason the scope is not the plugin's to choose: two plugins writing `position` to
  // the same book are writing two different things, and one flat namespace would make one
  // silently overwrite the other.
  const doc = emptyDoc('itm_1');
  setData(doc, AUDIO, 'position', 900, { actor: 'alice' });
  setData(doc, READER, 'position', 12, { actor: 'alice' });
  expect(dataOf(doc, AUDIO)).toEqual({ position: 900 });
  expect(dataOf(doc, READER)).toEqual({ position: 12 });
});

test('the later write wins, whichever replica it came from', () => {
  // A listener finishes a chapter on their phone; their laptop has been offline for a day
  // and also wrote. Both are real writes and neither device is authoritative.
  const phone = emptyDoc('itm_1');
  const laptop = emptyDoc('itm_1');
  setData(laptop, AUDIO, 'position', 100, { actor: 'laptop', at: 5 });
  setData(phone, AUDIO, 'position', 4200, { actor: 'phone', at: 9 });

  expect(dataOf(mergeDoc(phone, laptop), AUDIO)).toEqual({ position: 4200 });
  // And merging is COMMUTATIVE, or two devices syncing in different orders disagree
  // forever — which is the whole point of using a CRDT rather than a last-writer table.
  expect(dataOf(mergeDoc(laptop, phone), AUDIO)).toEqual({ position: 4200 });
});

test('a tie is broken the same total, deterministic way as everything else', () => {
  const a = emptyDoc('itm_1');
  const b = emptyDoc('itm_1');
  setData(a, AUDIO, 'position', 1, { actor: 'aaa', at: 7 });
  setData(b, AUDIO, 'position', 2, { actor: 'zzz', at: 7 });
  // Higher actor string wins — arbitrary, but both sides compute the same answer.
  expect(dataOf(mergeDoc(a, b), AUDIO)).toEqual({ position: 2 });
  expect(dataOf(mergeDoc(b, a), AUDIO)).toEqual({ position: 2 });
});

test('two devices writing DIFFERENT keys in one scope both survive', () => {
  // Merged per key rather than per scope. Picking a whole scope would drop one of these,
  // which is the bug this test exists to prevent.
  const phone = emptyDoc('itm_1');
  const laptop = emptyDoc('itm_1');
  setData(phone, AUDIO, 'position', 4200, { actor: 'phone', at: 3 });
  setData(laptop, AUDIO, 'rate', 1.5, { actor: 'laptop', at: 4 });
  expect(dataOf(mergeDoc(phone, laptop), AUDIO)).toEqual({ position: 4200, rate: 1.5 });
});

test('forgetting a key is a tombstone, so it cannot be undone by a stale replica', () => {
  const doc = emptyDoc('itm_1');
  setData(doc, AUDIO, 'position', 4200, { actor: 'phone', at: 3 });
  const stale = mergeDoc(emptyDoc('itm_1'), doc);   // a replica that still has the value

  removeData(doc, AUDIO, 'position', { actor: 'phone', at: 8 });
  expect(dataOf(doc, AUDIO)).toEqual({});

  // A delete that removed the entry outright would lose to the stale copy on merge.
  expect(dataOf(mergeDoc(doc, stale), AUDIO)).toEqual({});
  expect(dataOf(mergeDoc(stale, doc), AUDIO)).toEqual({});
});

test('data merges alongside tags without disturbing them', () => {
  // The sidecar carries several maps and a merge that dropped one would not be a merge.
  const a = emptyDoc('itm_1');
  const b = emptyDoc('itm_1');
  setTag(a, 'favourite', { actor: 'alice', at: 1 });
  setData(b, AUDIO, 'position', 60, { actor: 'alice', at: 2 });
  const merged = mergeDoc(a, b);
  expect(merged.tags.favourite.present).toBe(true);
  expect(dataOf(merged, AUDIO)).toEqual({ position: 60 });
});

test('a scope or key that is missing is refused rather than written as "undefined"', () => {
  const doc = emptyDoc('itm_1');
  expect(setData(doc, '', 'k', 1)).toBe(null);
  expect(setData(doc, AUDIO, '', 1)).toBe(null);
  expect(dataOf(doc, AUDIO)).toEqual({});
  // And reading a scope nobody has written is empty, not a throw.
  expect(dataOf(doc, 'trove+plugin:nobody/none')).toEqual({});
  expect(dataOf(null, AUDIO)).toEqual({});
});
