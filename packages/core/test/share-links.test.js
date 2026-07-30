// Links you can paste into a message.
//
// `trove:` addresses an item inside the drive and means nothing to a browser. A share link
// is the same address wearing an http coat — same collection, same explicit name-or-id
// selector — so anything that resolves one resolves the other, and a rename breaks both
// visibly rather than one of them silently retargeting.

import { test, expect } from 'bun:test';
import { shareUrl, parseShareUrl, troveUriFromShareUrl, parseTroveUri, SHARE_PATH } from '../src/links.js';

const node = { id: 'itm_abc123', name: 'sailing.txt', collectionId: 'default' };

test('a share link addresses a collection and an item', () => {
  expect(shareUrl(node)).toBe('/c/default/i/sailing.txt');
  expect(shareUrl(node, 'https://trove.example.com')).toBe('https://trove.example.com/c/default/i/sailing.txt');
  // A trailing slash on the origin must not double up.
  expect(shareUrl(node, 'https://trove.example.com/')).toBe('https://trove.example.com/c/default/i/sailing.txt');
  expect(SHARE_PATH).toBe('/c');
});

test('it round-trips, from a full URL or a bare path', () => {
  expect(parseShareUrl(shareUrl(node))).toEqual({ collection: 'default', by: 'name', value: 'sailing.txt' });
  expect(parseShareUrl(shareUrl(node, 'https://trove.example.com')))
    .toEqual({ collection: 'default', by: 'name', value: 'sailing.txt' });
});

test('by id, when a link should survive a rename', () => {
  const byId = shareUrl(node, '', 'id');
  expect(byId).toBe('/c/default/i/id:itm_abc123');
  expect(parseShareUrl(byId)).toEqual({ collection: 'default', by: 'id', value: 'itm_abc123' });
});

test('a name that looks like an id is still a name', () => {
  // The same rule the trove: scheme enforces. A link that silently retargets is worse than
  // one that visibly breaks.
  const odd = { ...node, name: 'id_notreally.txt' };
  expect(parseShareUrl(shareUrl(odd)).by).toBe('name');
  expect(parseShareUrl(shareUrl(odd)).value).toBe('id_notreally.txt');
});

test('names with awkward characters survive the trip', () => {
  const awkward = { ...node, name: 'holiday photos/2026 #1 & friends.jpg' };
  const link = shareUrl(awkward);
  expect(link).not.toContain(' ');
  expect(parseShareUrl(link).value).toBe('holiday photos/2026 #1 & friends.jpg');
});

test('a share link and a trove: URI are the same address', () => {
  // Which is the point: one resolver, two spellings.
  const uri = troveUriFromShareUrl(shareUrl(node));
  expect(uri).toBe('trove:default?name=sailing.txt');
  expect(parseTroveUri(uri)).toEqual({ collection: 'default', by: 'name', value: 'sailing.txt' });

  const byId = troveUriFromShareUrl(shareUrl(node, '', 'id'));
  expect(parseTroveUri(byId)).toEqual({ collection: 'default', by: 'id', value: 'itm_abc123' });
});

test('anything that is not a share link is simply not one', () => {
  // This parses whatever was in the address bar; an ordinary page is not an error.
  expect(parseShareUrl('/')).toBe(null);
  expect(parseShareUrl('/settings')).toBe(null);
  expect(parseShareUrl('/c/default')).toBe(null);
  expect(parseShareUrl('/c//i/x')).toBe(null);
  expect(parseShareUrl('https://trove.example.com/other')).toBe(null);
  expect(parseShareUrl('not a url at all')).toBe(null);
});

test('a malformed collection or selector resolves to nothing', () => {
  // These reach a lookup, so garbage stops here rather than there.
  expect(parseShareUrl('/c/../i/x')).toBe(null);
  expect(parseShareUrl('/c/default/i/%E0%A4%A')).toBe(null); // bad escape
  expect(parseShareUrl(`/c/default/i/${'a'.repeat(300)}`)).toBe(null);
});

test('a link needs something to point at', () => {
  expect(() => shareUrl({ name: 'x' })).toThrow(/needs a collection/);
  expect(() => shareUrl({ collectionId: 'default' }, '', 'id')).toThrow(/Nothing to link to/);
});

test('no key ever rides in a link', () => {
  // A link is pasted into chats, logged by proxies, and kept in history forever. The
  // recipient gets the item because they are allowed the collection, like everywhere else.
  const encrypted = { ...node, collectionId: 'private', encryption: { fingerprint: 'ab'.repeat(16) } };
  const link = shareUrl(encrypted, 'https://trove.example.com');
  expect(link).toBe('https://trove.example.com/c/private/i/sailing.txt');
  expect(link).not.toContain('ab'.repeat(16));
  expect(link).not.toContain('#');
});
