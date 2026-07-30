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
| [003](003-component-state-and-the-ui-bag.md) | Component state, render granularity, and the `ui` bag | Component state lives outside the reactive graph, and the machinery compensating for it is most of what `ui` carries |
| [005](005-rotation-resume-mid-object.md) | Rotation: resume mid-object | A single object larger than a slice budget retries from the start forever |
| [007](007-encrypted-multipart-is-sequential.md) | Encrypted multipart is sequential | Large uploads to encrypted collections lose upload concurrency |
