// W3C Audiobooks / LPF.
//
// Almost every case here is a SHAPE, not a value: the spec is schema.org-flavoured, so a
// title is a string or an object with a `name` or an array of either, and a book that fails
// to open usually fails on the shape it chose rather than on anything being missing.

import { test, expect } from 'bun:test';
import {
  oneOf, listOf, parseDuration, parsePublication, chaptersFrom, manifestEntry, resolveHref,
} from '../src/lpf.js';

test('one value, in all three shapes schema.org permits', () => {
  expect(oneOf('Plain')).toBe('Plain');
  expect(oneOf({ name: 'Wrapped' })).toBe('Wrapped');
  expect(oneOf([{ name: 'First' }, { name: 'Second' }])).toBe('First');
  expect(oneOf({ '@value': 'Typed' })).toBe('Typed');
  expect(oneOf(null)).toBe(null);
});

test('a list, because one author and five authors are both normal', () => {
  expect(listOf('Solo')).toEqual(['Solo']);
  expect(listOf([{ name: 'A' }, 'B'])).toEqual(['A', 'B']);
  expect(listOf(undefined)).toEqual([]);
});

test('ISO 8601 durations become seconds', () => {
  expect(parseDuration('PT1H2M3S')).toBe(3723);
  expect(parseDuration('PT45S')).toBe(45);
  expect(parseDuration('PT1.5S')).toBe(1.5);
  expect(parseDuration('P1DT1H')).toBe(90_000);
  // Not a duration, or a zero one: null rather than 0, so a caller can tell "the book does
  // not say" from "the book says nothing is here".
  expect(parseDuration('1:02:03')).toBe(null);
  expect(parseDuration('PT0S')).toBe(null);
  expect(parseDuration(undefined)).toBe(null);
});

test('a publication becomes a title, authors and an ordered track list', () => {
  const pub = parsePublication(JSON.stringify({
    '@context': ['https://schema.org', 'https://www.w3.org/ns/pub-context'],
    name: { '@value': 'The Long Book' },
    author: [{ name: 'A. Writer' }, 'Someone Else'],
    duration: 'PT2H',
    readingOrder: [
      { url: 'audio/01.mp3', encodingFormat: 'audio/mpeg', duration: 'PT1H', name: 'Part One' },
      { url: 'audio/02.mp3', encodingFormat: 'audio/mpeg', duration: 'PT1H', name: 'Part Two' },
    ],
  }));
  expect(pub.title).toBe('The Long Book');
  expect(pub.authors).toEqual(['A. Writer', 'Someone Else']);
  expect(pub.duration).toBe(7200);
  expect(pub.tracks.map((t) => t.href)).toEqual(['audio/01.mp3', 'audio/02.mp3']);
});

test('`href` is read as well as `url`, because real files use both', () => {
  // The spec says `url`. Plenty of books in the wild say `href`, and reading both costs one
  // `??` against a book that otherwise does not open at all.
  const pub = parsePublication(JSON.stringify({ readingOrder: [{ href: 'a.mp3' }] }));
  expect(pub.tracks[0].href).toBe('a.mp3');
});

test('a stated total beats a computed one, and a computed one beats nothing', () => {
  const stated = parsePublication(JSON.stringify({
    duration: 'PT10S', readingOrder: [{ url: 'a', duration: 'PT1S' }],
  }));
  expect(stated.duration).toBe(10);

  const summed = parsePublication(JSON.stringify({
    readingOrder: [{ url: 'a', duration: 'PT1S' }, { url: 'b', duration: 'PT2S' }],
  }));
  expect(summed.duration).toBe(3);

  // One track without a duration makes the sum a guess, and a guessed total is worse than
  // none: a progress bar built on it is wrong for the whole book.
  const partial = parsePublication(JSON.stringify({
    readingOrder: [{ url: 'a', duration: 'PT1S' }, { url: 'b' }],
  }));
  expect(partial.duration).toBe(null);
});

test('tracks are laid onto one timeline, because that is what a player has', () => {
  const chapters = chaptersFrom([
    { href: 'a', duration: 60, title: 'One' },
    { href: 'b', duration: 90, title: null },
    { href: 'c', duration: 30, title: 'Three' },
  ]);
  expect(chapters.map((c) => c.time)).toEqual([0, 60, 150]);
  // An untitled track still needs a name in a chapter list.
  expect(chapters[1].title).toBe('Track 2');
});

test('a book zipped one level too deep still opens', () => {
  // The single most common way a valid book fails: zipping the FOLDER rather than its
  // contents, which nests everything one level down.
  expect(manifestEntry({ 'publication.json': 1 })).toBe('publication.json');
  expect(manifestEntry({ 'My Book/publication.json': 1 })).toBe('My Book/publication.json');
  expect(manifestEntry({ 'notes.txt': 1 })).toBe(null);

  // And its track hrefs resolve against wherever the manifest turned out to be.
  expect(resolveHref('My Book/publication.json', 'audio/01.mp3')).toBe('My Book/audio/01.mp3');
  expect(resolveHref('publication.json', 'audio/01.mp3')).toBe('audio/01.mp3');
  expect(resolveHref('My Book/publication.json', '/audio/01.mp3')).toBe('audio/01.mp3');
});

test('a manifest that is not JSON says so, in terms of the file', () => {
  expect(() => parsePublication('<html>')).toThrow(/publication\.json is not valid JSON/);
});
