import { test, expect } from 'bun:test';
import { parseTagQuery, matchesTagFilters, filterLabel } from '../src/bl/tagQuery.js';

test('parseTagQuery splits filters from free text', () => {
  const { text, filters } = parseTagQuery('sunset #rating:>=4 #fav beach #status:=done');
  expect(text).toBe('sunset beach');
  expect(filters).toEqual([
    { key: 'rating', op: '>=', value: '4', present: false },
    { key: 'fav', present: true },
    { key: 'status', op: '=', value: 'done', present: false },
  ]);
});

test('parseTagQuery handles operators, shorthand equality, and quoted values', () => {
  expect(parseTagQuery('#a:<=10').filters[0]).toEqual({ key: 'a', op: '<=', value: '10', present: false });
  expect(parseTagQuery('#a:5').filters[0]).toEqual({ key: 'a', op: '=', value: '5', present: false }); // shorthand
  expect(parseTagQuery('#label:"in progress"').filters[0]).toEqual({ key: 'label', op: '=', value: 'in progress', present: false });
});

test('matchesTagFilters: presence + numeric + string comparisons over tags/meta', () => {
  const node = { facets: { tags: { fav: 'yes', rating: '5' } }, meta: { status: 'done' } };
  expect(matchesTagFilters(node, parseTagQuery('#fav').filters)).toBe(true);
  expect(matchesTagFilters(node, parseTagQuery('#missing').filters)).toBe(false);
  expect(matchesTagFilters(node, parseTagQuery('#rating:>=4').filters)).toBe(true);   // numeric
  expect(matchesTagFilters(node, parseTagQuery('#rating:>5').filters)).toBe(false);
  expect(matchesTagFilters(node, parseTagQuery('#status:=done').filters)).toBe(true);  // string
  expect(matchesTagFilters(node, parseTagQuery('#status:!=done').filters)).toBe(false);
  // AND across filters.
  expect(matchesTagFilters(node, parseTagQuery('#fav #rating:<=5 #status:=done').filters)).toBe(true);
  expect(matchesTagFilters(node, parseTagQuery('#fav #rating:>5').filters)).toBe(false);
});

test('a removed tag (null value) reads as absent', () => {
  const node = { facets: { tags: { fav: null } } };
  expect(matchesTagFilters(node, parseTagQuery('#fav').filters)).toBe(false);
});

test('filterLabel renders a compact label', () => {
  expect(filterLabel({ key: 'fav', present: true })).toBe('#fav');
  expect(filterLabel({ key: 'rating', op: '>=', value: '4' })).toBe('#rating:>=4');
});
