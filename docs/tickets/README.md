# Tickets

Tracked here rather than in GitHub Issues, so a ticket lands in the same review as the
change that closes it and a checkout is the whole picture.

One file per ticket, `NNN-short-name.md`. Numbers are allocated in order and not reused.
A ticket that is done is deleted in the commit that finishes it — git remembers, and a
directory of closed tickets is a directory nobody reads.

| # | Ticket | Why it matters |
|---|--------|----------------|
| [002](002-admin-console.md) | Admin console | Collections, API keys and per-plugin egress are still not where an administrator would look |
| [011](011-writefile-stores-plaintext.md) | `writeFile` stores plaintext | The server-side write path ignores a collection's encryption entirely |
