# Tickets

Tracked here rather than in GitHub Issues, so a ticket lands in the same review as the
change that closes it and a checkout is the whole picture.

One file per ticket, `NNN-short-name.md`. Numbers are allocated in order and not reused.
A ticket that is done is deleted in the commit that finishes it — git remembers, and a
directory of closed tickets is a directory nobody reads.

| # | Ticket | Why it matters |
|---|--------|----------------|
| [001](001-encryption-admin-ui.md) | Encryption admin UI | Encryption works end to end and is reachable only by hand-written API calls |
| [002](002-admin-console.md) | Admin console | Drive-level administration is scattered across Settings, the Activity panel and nothing |
| [003](003-move-dispatch-out-of-the-ui-bag.md) | Move dispatch out of the render bag | `ui` carries command execution and plugin management through 14 modules of pure render code |
| [004](004-rotation-routes-and-scheduling.md) | Rotation: routes and scheduling | The rotation walker is complete and nothing can start it |
| [005](005-rotation-resume-mid-object.md) | Rotation: resume mid-object | A single object larger than a slice budget retries from the start forever |
| [006](006-share-link-routing.md) | Share link routing | Links parse and nothing opens them |
| [007](007-encrypted-multipart-is-sequential.md) | Encrypted multipart is sequential | Large uploads to encrypted collections lose upload concurrency |
