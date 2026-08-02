# 028 — LPF audiobooks are barely indexed

The indexer *runs* on `.lpf` — the contribution matches `.lpf` and
`application/lpf+zip`, and `fromLpf` reads the zip's central directory, finds
`publication.json` and returns chapters and a cover. What it does not do is produce the
metadata an m4b produces.

## What comes out today

`bookIndexer.js` `fromLpf` builds exactly three fields:

```js
const book = { title: pub.title, author: pub.authors[0], duration: pub.duration };
```

against an m4b's title, author, narrator, series, part, album, genre, publisher, year,
language, description, copyright and asin. Since the tags are derived from that record,
an LPF book gets **one tag** (author) where an m4b gets seven — so it is missing from
`#narrator:`, `#series:`, `#genre:` and the rest.

The cause is upstream of the indexer: `lpf.js` `parsePublication` only extracts
`{ title, authors, duration, cover, tracks }`. Everything else in the manifest is dropped
on the floor before the indexer sees it.

## What to do

Read the rest of the publication manifest. A W3C Audiobooks / schema.org manifest
routinely carries `readBy` (the narrator), `inLanguage`, `publisher`, `datePublished`,
`abridged`, `description` and `belongsTo` (series, with `position` for the part) — which
map onto the fields the m4b path already produces.

`seriesOf` in the indexer then applies unchanged: an explicit series wins, and the
album-shaped fallback is m4b-specific so it simply will not fire here.

## Notes

- **This has not been verified against a real `.lpf`.** The analysis is from the source;
  the first step is to get one and see what its manifest actually carries, because the
  spec permits far more than most producers emit.
- The point of the shared record is that a reader of the contribution cannot tell which
  container it came from. Three fields versus thirteen breaks that, and the player's
  byline is where it shows: an LPF book has no "read by".
