# No folders: a flat drive held together by links

## The change

A collection is a **flat set of uniquely-named items**. There is no `parentId`, no
`path`, no folder node, and no move. Discovery is search; grouping is links.

## Why

A folder is a weak way to say things belong together. It can't say *why*, it only
allows one answer per file, and the grouping itself is invisible — you can't search it,
comment on it, or link to it. In practice a folder tree encodes one person's taxonomy at
one moment, and everyone else navigates it by guessing.

The replacement is an item that links other items. A markdown document called
`reading-list.md` does everything a folder did and several things it couldn't:

| | folder | a document that links |
| --- | --- | --- |
| groups things | yes | yes |
| says *why* | no | it's prose |
| one item in several groups | no (one parent) | yes |
| the grouping is searchable | no | it's a document |
| you can comment on the grouping | no | it has a conversation |
| survives disagreement about taxonomy | one tree wins | make another document |

## Addressing

```
trove:default?name=sailing.txt     canonical, by name
trove:default/sailing.txt          shorthand for the same thing
trove:default?id=itm_01H2X8F4KQ    by id — survives a rename
```

Three decisions worth stating, because each had a plausible alternative:

**The selector is explicit.** `?name=` and `?id=` rather than inferring from the shape
of the segment. A name that happened to look like an id would otherwise resolve to
something else entirely, and a link that silently retargets is worse than one that
visibly breaks. Passing both is a contradiction, so it parses as nothing rather than
picking a winner.

**Names are the default, and names are unique per collection.** That uniqueness is what
makes `?name=` resolve to exactly one item — it's the same constraint that used to be
per-folder, lifted to the collection. The cost is that renaming breaks inbound links.
That is the accepted trade: a link you can't hand-write isn't a link people will write,
and the whole point is that grouping happens in prose. `?id=` exists for links a tool
inserts, where stability matters more than legibility. Breakage is visible — a broken
link says what it was looking for and that it may have been renamed or deleted.

**Extraction reads raw text, not parsed markdown.** A link is just as real in an HTML
`href`, a bare mention, or a front-matter list. The question the index answers is "what
does this item reference?", not "what does one renderer consider a link?".

## Backlinks

Links only point one way, which would make a flat drive navigable forward and useless
backward — you could follow a document's list but never find out what gathers a given
item up. So a built-in links indexer records each item's outbound `trove:` URIs as a
contribution, and `MetadataStore.findLinksTo` inverts it. Every item shows what links to
it; that panel is the honest answer to "where does this live?".

The count is also exposed as a tag, so `#links > 0` finds the documents acting as
indexes.

Backlinks are permission-filtered per item, because they can cross collections: you must
not learn that something exists in a collection you can't read merely because something
you *can* read points at it.

## What this costs

- **No move.** Nothing to move between. Renaming is the only relocation.
- **Renames break name links.** Visibly, and only for `?name=` links.
- **One flat list can get long.** Search is the primary answer; the full listing is a
  fallback. If a collection grows past what a listing serves, the answer is another
  collection or a better index document — not a folder.
- **No migration path from a tree.** This was a clean break; existing folder records are
  not read.
