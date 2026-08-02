# 030 — the grid should show a title, not a filename

A tile shows `node.name`. For an indexed book that means

```
All the Skills_ A Deck-Building LitRPG_ All the Skills, Book 1 [B0BLTLDSYM].m4b
```

wrapped over two lines and truncated, when the drive already knows the title is
**All the Skills: A Deck-Building LitRPG**. The indexer put it there — the same
contribution the tile is already reading for its thumbnail.

## What to do

Prefer a contributed `metadata.book.title` (or a general `metadata.title`) over the
filename, and fall back to the filename when there is none.

There is a precedent to follow rather than invent: `thumbnailOf` in `bl/fileType.js` reads
one known key across contributions without caring which contributor supplied it. A
`titleOf` alongside it is the same shape, and the grid already imports from there.

## Notes

- The filename must stay reachable — it is what someone searches for, and what they need
  when something is wrong with the file. `title` attribute on the tile at minimum.
- The list view has the same argument and more room; decide whether it shows title with
  filename beneath, or stays as it is.
- Scope the key deliberately. `metadata.book.title` is the audiobook indexer's; a general
  `metadata.title` any indexer can write is more useful and needs one line saying who owns
  it, or two plugins will disagree about a file's name.
- Sorting and search still key on the filename. A grid sorted by name but labelled by
  title reads as unsorted, so this is a real question to answer, not an afterthought.
