// What a file is CALLED on screen, versus what it is stored as.
//
// A filename is an identity; a title is a label. For an indexed book they are very
// different strings, and the drive already knows the second — from the same contribution
// the tile reads for its thumbnail.

import { test, expect } from 'bun:test';
import { titleOf } from '../src/bl/fileType.js';

const BOOK = 'All the Skills_ A Deck-Building LitRPG_ All the Skills, Book 1 [B0BLTLDSYM].m4b';

test('a contributed title wins over the filename', () => {
  expect(titleOf({
    name: BOOK,
    contributions: {
      'trove+contrib:3sln.com/audiobook/book': {
        metadata: { book: { title: 'All the Skills: A Deck-Building LitRPG' } },
      },
    },
  })).toBe('All the Skills: A Deck-Building LitRPG');
});

test('the general key beats the plugin-specific one', () => {
  // `metadata.title` is the key any indexer may write and means "what this is called".
  // `metadata.book.title` is read too because the audiobook indexer keeps the whole book
  // record under one key — but a general title, if present, is the more considered answer.
  expect(titleOf({
    name: 'x.m4b',
    contributions: { a: { metadata: { title: 'General', book: { title: 'Book' } } } },
  })).toBe('General');
});

test('the view does not care which contributor supplied it', () => {
  // Same indifference `thumbnailOf` has. A drive with two indexers writing a title has a
  // configuration problem, not a rendering one.
  expect(titleOf({
    name: 'x.m4b',
    contributions: { 'core.text': { metadata: {} }, 'some.plugin/x': { metadata: { title: 'Found' } } },
  })).toBe('Found');
});

test('no contribution, a blank one, or junk all fall back to the filename', () => {
  expect(titleOf({ name: 'notes.md' })).toBe('notes.md');
  expect(titleOf({ name: 'notes.md', contributions: {} })).toBe('notes.md');
  expect(titleOf({ name: 'notes.md', contributions: { a: { metadata: { title: '   ' } } } })).toBe('notes.md');
  expect(titleOf({ name: 'notes.md', contributions: { a: { metadata: { title: 42 } } } })).toBe('notes.md');
  // And nothing at all is an empty string rather than a throw — a view renders this.
  expect(titleOf(null)).toBe('');
});

test('a title is trimmed, because it is going into a layout', () => {
  expect(titleOf({ name: 'x', contributions: { a: { metadata: { title: '  Padded  ' } } } })).toBe('Padded');
});
