# Tickets

Tracked here rather than in GitHub Issues, so a ticket lands in the same review as the
change that closes it and a checkout is the whole picture.

One file per ticket, `NNN-short-name.md`. Numbers are allocated in order and not reused.
A ticket that is done is deleted in the commit that finishes it — git remembers, and a
directory of closed tickets is a directory nobody reads.

| # | Ticket | Why it matters |
|---|--------|----------------|
| [018](018-delete-the-dead-machinery.md) | Delete the dead machinery | ~400 unreachable lines, most of it advertised in module headers as live |
| [019](019-the-prose-has-drifted-from-the-code.md) | The prose has drifted from the code | A wrong comment in this codebase is believed, because the right ones are so good |
| [020](020-state-that-escapes-the-engine.md) | State that escapes the engine | Side channels the resource graph cannot see — `window.__trove` ships to production |
| [021](021-nothing-limits-what-one-caller-can-cost.md) | Nothing limits what one caller can cost | No rate limiting anywhere — a leaked key or an open drive can spend CPU, bandwidth and embedding credit without bound |
| [022](022-a-plugins-directory-and-its-first-tenant.md) | A plugins directory, and its first tenant | `plugins/*` in the monorepo, and storia's audiobook player ported into it as a docking, media-session viewer |

Tickets 012–020 come from a multi-agent architecture audit (Aug 2026): eight lenses over
the four packages, every finding put through an adversary whose job was to refute it. 16 were
killed that way. The audit's verdict was that nothing here needs rearchitecting — it needs
*finishing, collapsing and deleting*.
