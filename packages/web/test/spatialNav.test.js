// Which way is "right"?
//
// Tab order is written for reading order, and on a remote that is wrong often enough to
// be unusable: pressing right lands three rows down because that is what came next in
// the DOM. So the arrows are answered from geometry, and the scoring is where that
// either works or doesn't. These are the cases that make the difference between a drive
// you can browse from a sofa and one where the selection jumps somewhere unrelated.

import { test, expect } from 'bun:test';
import { scoreCandidate } from '../src/platform/spatialNav.js';

const rect = (x, y, w = 100, h = 30) => ({
  left: x, top: y, right: x + w, bottom: y + h, width: w, height: h,
});
// Which of these is the better move, if either.
const pick = (from, candidates, dir) => {
  let best = null;
  let bestScore = Infinity;
  for (const [name, r] of Object.entries(candidates)) {
    const s = scoreCandidate(from, r, dir);
    if (s == null || s >= bestScore) continue;
    bestScore = s;
    best = name;
  }
  return best;
};

test('a candidate behind you is not a candidate', () => {
  const from = rect(200, 200);
  expect(scoreCandidate(from, rect(0, 200), 'right')).toBe(null);
  expect(scoreCandidate(from, rect(400, 200), 'right')).not.toBe(null);
  expect(scoreCandidate(from, rect(200, 0), 'down')).toBe(null);
  expect(scoreCandidate(from, rect(200, 400), 'down')).not.toBe(null);
});

test('nearer in the direction of travel wins', () => {
  const from = rect(0, 100);
  expect(pick(from, { near: rect(150, 100), far: rect(600, 100) }, 'right')).toBe('near');
});

test('lined up beats slightly closer but off to the side', () => {
  // This is the case that makes tab order feel broken. The off-axis item is nominally
  // nearer, but pressing DOWN and landing in a different column is not what anyone means.
  const from = rect(0, 0);
  const picked = pick(from, {
    below: rect(0, 120),
    offToTheSide: rect(700, 90),
  }, 'down');
  expect(picked).toBe('below');
});

test('a rail beside a list: right leaves the rail for the list, not the rail below it', () => {
  // The real geometry that broke naive scoring — a narrow vertical rail of icons next to
  // a wide panel. Every rail item below is closer in raw distance than anything in the
  // panel, so distance alone sends "right" straight down the rail.
  const railItem = rect(6, 200, 40, 40);
  const picked = pick(railItem, {
    railBelow: rect(6, 250, 40, 40),
    panelRow: rect(300, 205, 600, 34),
  }, 'right');
  expect(picked).toBe('panelRow');
  // And down still walks the rail, rather than jumping into the panel.
  expect(pick(railItem, { railBelow: rect(6, 250, 40, 40), panelRow: rect(300, 205, 600, 34) }, 'down'))
    .toBe('railBelow');
});

test('within a list, down goes to the next row and not two rows on', () => {
  const rows = { r1: rect(0, 40, 500, 36), r2: rect(0, 80, 500, 36), r3: rect(0, 120, 500, 36) };
  expect(pick(rect(0, 0, 500, 36), rows, 'down')).toBe('r1');
  expect(pick(rows.r1, { r2: rows.r2, r3: rows.r3 }, 'down')).toBe('r2');
});

test('items sharing a row are reachable sideways even when they overlap by a pixel', () => {
  // Buttons in a toolbar frequently overlap by a hair after rounding. A strict
  // "must start after I end" test would make half of a toolbar unreachable.
  const a = rect(0, 0, 60, 40);
  const b = { left: 59, top: 0, right: 119, bottom: 40, width: 60, height: 40 };
  expect(scoreCandidate(a, b, 'right')).not.toBe(null);
});

test('a taller neighbour that merely overlaps does not beat the one directly in line', () => {
  // Centre alignment is the tie-break: two candidates both overlap the origin's column,
  // but one is centred on it.
  const from = rect(200, 0, 100, 30);
  const picked = pick(from, {
    centred: rect(200, 60, 100, 30),
    wideAndOff: rect(120, 60, 300, 30),
  }, 'down');
  expect(picked).toBe('centred');
});
