// The `trove:` URI — how one item addresses another now that there are no folders —
// plus the links indexer and the backlink lookup it feeds.

import { test, expect } from 'bun:test';
import {
  parseTroveUri, isTroveUri, troveUri, troveUrisFor, canonicalTroveUri, extractTroveLinks,
} from '../src/links.js';
import { createVfs, MemoryStorage } from '../src/index.js';
import { outboundLinks } from '../src/metadata/interface.js';

test('a link names a collection and one explicit selector', () => {
  expect(parseTroveUri('trove:default?name=sailing.txt')).toEqual({ collection: 'default', by: 'name', value: 'sailing.txt' });
  expect(parseTroveUri('trove:default?id=itm_1')).toEqual({ collection: 'default', by: 'id', value: 'itm_1' });
  // The pathname shorthand is unambiguous: that slot only ever means a name.
  expect(parseTroveUri('trove:default/sailing.txt')).toEqual({ collection: 'default', by: 'name', value: 'sailing.txt' });
  // Names with awkward characters survive via percent-encoding.
  expect(parseTroveUri('trove:default?name=a%2Fb.md').value).toBe('a/b.md');
  expect(parseTroveUri('trove:default?name=notes%20%26%20ideas.md').value).toBe('notes & ideas.md');
  expect(isTroveUri('TROVE:default/a.md')).toBe(true); // schemes are case-insensitive
});

test('an ambiguous or incomplete link is not a link', () => {
  // Both selectors at once is a contradiction — picking one silently would make the
  // same text mean different things depending on which we preferred.
  expect(parseTroveUri('trove:default?id=x&name=y')).toBe(null);
  expect(parseTroveUri('trove:default')).toBe(null);        // no item selected
  expect(parseTroveUri('trove:default?name=')).toBe(null);  // empty selector
  expect(parseTroveUri('trove:/x')).toBe(null);             // no collection
  expect(parseTroveUri('trove:bad collection/x')).toBe(null);
  expect(parseTroveUri('https://example.com/a')).toBe(null);
  expect(parseTroveUri(null)).toBe(null);
  expect(parseTroveUri(42)).toBe(null);
});

test('the shorthand and the canonical form are the same link', () => {
  expect(canonicalTroveUri('trove:default/a.md')).toBe(canonicalTroveUri('trove:default?name=a.md'));
  expect(canonicalTroveUri('nonsense')).toBe(null);

  const node = { id: 'itm_9', collectionId: 'work', name: 'plan.md' };
  expect(troveUri(node)).toBe('trove:work?name=plan.md');
  expect(troveUri(node, 'id')).toBe('trove:work?id=itm_9');
  // Both forms address the same item, which is why a backlink query looks for both.
  expect(troveUrisFor(node)).toEqual(['trove:work?name=plan.md', 'trove:work?id=itm_9']);
});

test('extraction finds links wherever they appear, and dedupes by target', () => {
  const found = extractTroveLinks(`
    # Trip notes
    See [the log](trove:default/sailing.txt) and <a href="trove:default?id=itm_2">the photo</a>.
    A bare mention works too: trove:default?name=weather.md.
    The same target twice — trove:default?name=sailing.txt — collapses to one.
    Not a link: trove:/nope, and https://example.com/x
  `);
  expect(found.map((l) => l.uri)).toEqual([
    'trove:default?name=sailing.txt',
    'trove:default?id=itm_2',
    'trove:default?name=weather.md',
  ]);
  // Trailing sentence punctuation isn't part of the name.
  expect(found[2].value).toBe('weather.md');
  expect(extractTroveLinks('')).toEqual([]);
  expect(extractTroveLinks(null)).toEqual([]);
});

test('the links indexer records outbound links, and backlinks invert them', async () => {
  const vfs = await createVfs({ storage: new MemoryStorage() });
  const target = await vfs.writeFile('sailing.txt', 'Tacking upwind at dawn.', { contentType: 'text/plain' });
  const other = await vfs.writeFile('weather.md', 'Forecast.', { contentType: 'text/markdown' });
  const index = await vfs.writeFile('trips.md',
    'Trips\n\n- [Sailing](trove:default/sailing.txt)\n- [Weather](trove:default?name=weather.md)\n',
    { contentType: 'text/markdown' });

  // Outbound: what this document points at, canonicalized.
  const indexNode = await vfs.stat(index.id);
  expect(outboundLinks(indexNode)).toEqual([
    'trove:default?name=sailing.txt',
    'trove:default?name=weather.md',
  ]);
  // Surfaced as a count too, so `#links > 0` finds the documents that act as indexes.
  expect(indexNode.tags.links).toBe(2);

  // Inbound: what gathers this item up — the thing that replaces "which folder?".
  expect((await vfs.backlinks(target.id)).map((n) => n.name)).toEqual(['trips.md']);
  expect((await vfs.backlinks(other.id)).map((n) => n.name)).toEqual(['trips.md']);
  expect(await vfs.backlinks(index.id)).toEqual([]);
});

test('backlinks follow a link written by id across a rename', async () => {
  const vfs = await createVfs({ storage: new MemoryStorage() });
  const target = await vfs.writeFile('notes.md', 'x', { contentType: 'text/markdown' });
  await vfs.writeFile('by-name.md', `see trove:default?name=notes.md`, { contentType: 'text/markdown' });
  await vfs.writeFile('by-id.md', `see trove:default?id=${target.id}`, { contentType: 'text/markdown' });
  expect((await vfs.backlinks(target.id)).map((n) => n.name).sort()).toEqual(['by-id.md', 'by-name.md']);

  // Renaming breaks the by-name link — visibly, on purpose — and keeps the by-id one.
  await vfs.rename(target.id, 'renamed.md');
  expect((await vfs.backlinks(target.id)).map((n) => n.name)).toEqual(['by-id.md']);
  // …and the stale link now resolves to nothing rather than to whatever takes the name.
  expect(await vfs.find('trove:default?name=notes.md')).toBe(null);
});

test('a backlink limit is spent on rows the caller can see, not on ones they cannot', async () => {
  const vfs = await createVfs({ storage: new MemoryStorage() });
  const target = await vfs.writeFile('target.md', 'x', { contentType: 'text/markdown' });
  const uri = 'trove:default?name=target.md';
  const link = async (collectionId, name, at) => {
    const n = await vfs.metadata.create({ collectionId, name });
    await vfs.metadata.setContribution(n.id, 'core.links', { metadata: { links: [uri] } });
    // Backlinks come back newest-first; make the readable one the OLDEST so it is
    // exactly the row a post-filter would lose.
    vfs.metadata.nodes.get(n.id).updatedAt = at;
  };
  await link('default', 'visible.md', 1);
  for (let i = 0; i < 50; i++) await link('secret', `s${i}.md`, 100 + i);

  // Unscoped, the readable row falls outside a small limit entirely.
  const unscoped = await vfs.backlinks(target.id, { limit: 10 });
  expect(unscoped.some((n) => n.name === 'visible.md')).toBe(false);

  // Scoped, the limit applies to what the caller can actually see.
  const scoped = await vfs.backlinks(target.id, { limit: 10, collectionIds: ['default'] });
  expect(scoped.map((n) => n.name)).toEqual(['visible.md']);
});
