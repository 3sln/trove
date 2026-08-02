# Tickets

Tracked here rather than in GitHub Issues, so a ticket lands in the same review as the
change that closes it and a checkout is the whole picture.

One file per ticket, `NNN-short-name.md`. Numbers are allocated in order and not reused.
A ticket that is done is deleted in the commit that finishes it — git remembers, and a
directory of closed tickets is a directory nobody reads.

**Nothing open.** 026–032 came out of one run of the drive on real files: plugin storage
that shared one D1 binding across every user and plugin, a selection nobody could build,
LPF books indexed to a third of an m4b, a transfers panel that could not be dismissed,
grid tiles showing filenames over titles, a 500 MB book that opened onto a silent stall,
and a check that uninstalling a plugin does not strand its default opener.

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
