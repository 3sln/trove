# Tickets

Tracked here rather than in GitHub Issues, so a ticket lands in the same review as the
change that closes it and a checkout is the whole picture.

One file per ticket, `NNN-short-name.md`. Numbers are allocated in order and not reused.
A ticket that is done is deleted in the commit that finishes it — git remembers, and a
directory of closed tickets is a directory nobody reads.

**Open: 027, 028, 031, 032** — "Select this item" and a bulk mode; LPF books getting three
metadata fields where an m4b gets thirteen; a 520 MB book that opens onto a static
"Reading the book's structure…" with no spinner and a blocked main thread; and whether
uninstalling a plugin clears a default opener pointing at it.

**Open: 026** — plugin storage on Workers must be a Durable Object, not a shared D1
database. `D1SqliteProvider` cannot create a database on demand, so every plugin scope for
every user lives side by side in one binding; the code says so itself and keeps it only
because it is the strongest thing D1 allows.

024 was the view switcher appearing where switching is not a choice.
025 was the audiobook player: play did nothing (the sandbox CSP forbids loading media from
a URL, by design), no cover art, no rate control, a layout written only for the docked
case, and recent tiles that never drew a thumbnail. Closed by transmuxing to fragmented
MP4 in the frame and feeding a MediaSource.

023 was three defects found by opening one audiobook on a real drive:
a plugin viewer that had never run (an undeclared capability), plugin indexers that could
not run on Workers at all (a `data:` import workerd refuses), and upload-time indexing that
did not survive the request. All three fixed and verified end to end against a real
`worker_loaders` binding.

012–020 came from a multi-agent architecture audit (Aug 2026): eight
lenses over the four packages, every finding put through an adversary whose job was to
refute it, 16 killed that way. Its verdict was that nothing here needed rearchitecting — it
needed finishing, collapsing and deleting — and that is what those nine tickets were. 021
added rate limiting; 022 opened `plugins/` and put the audiobook player in it.

`git log` is where they went. Each closing commit carries the finding and the reasoning,
which is the half a ticket file was holding.
