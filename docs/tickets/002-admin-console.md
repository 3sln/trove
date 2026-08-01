# 002 — Admin console

Drive-level administration has accumulated in three places and no place. API keys are a
section of Settings. Storage diagnostics and the maintenance actions are in the Activity
panel, behind a status-bar item. Collection ACLs are in a dialog. Indexers, plugins,
capabilities and the storage driver registry are only visible through the API.

Each landed where it did for a local reason and the result is that there is nowhere to send
someone who has just been made an administrator.

## What it should gather

- **Collections** — create, ACLs, backing store, encryption (001), scan and rotate.
- **Access** — API keys (already built, move it), who holds what, the identity provider in
  force and whether auth is required.
- **Storage** — the driver registry as this deployment has it, the diagnostics check with
  its remedy, and usage.
- **Work** — running tasks, standing issues, the maintenance actions, cron health.
- **Extensions** — installed plugins, what each may do, which contribute indexers, and the
  egress each is permitted.

## Notes

- Everything here already exists as an API and most of it as a component; this is mostly
  gathering and routing rather than new capability.
- `requireHumanAdmin` already refuses API-key credentials for key management. Whatever
  administration moves here should keep that distinction rather than re-deriving it.
- Worth deciding early whether this is an activity-bar destination or a full-page route,
  because 006 introduces routes and the two decisions interact.

## Where this stands

The destination exists, beside Plugins and Settings, with Access, Storage, Extensions and
Work. The routing question is settled and settled by precedent rather than by preference:
006 established that this app does not put its state in the address bar — it consumes a
share path at boot and replaces it with `/` — so there is no router to hang a route on and
a destination is the consistent answer.

What it gathers today is the part that was only reachable through `curl`: the identity
provider and whether auth is required, the storage driver registry as this deployment has
it, the capability flags that explain why a download is proxied or a usage figure missing,
the indexers (which read file contents in the clear, including from an encrypted
collection), the installed plugins with what each may do, and the running/standing work
counts. The storage check and the maintenance actions are reachable from it.

## Still to move

- **ACLs** — who may read or write a collection is still set through the API alone. This is
  the one part of the ticket that is new capability rather than gathering, which is why it
  did not come with the rest.
- **API keys** — built, and still a section of Settings. Linked from here rather than
  duplicated, because two places to revoke a credential is worse than one place in the
  wrong screen. Moving it should keep `requireHumanAdmin` refusing API-key credentials.
- **Per-plugin egress** — the endpoints a plugin may reach are in its manifest and shown at
  install; this lists what each may DO but not where it may talk to.
- **Cron health** — nothing currently reports whether the scheduled sweep is firing, so
  there is nothing to gather yet.

## Done when

There is one place an administrator goes, and the things that are currently only reachable
through `curl` are reachable through it.

Collections landed: every collection, the store it sits on, whether it is sealed and under
which key fingerprint, what you may do to it, and the actions — open, scan, rotate, create.
Rows and their actions are built in `bl/services.js:collectionAdminOf` and ride the explorer
query, so the component only draws. Rotation routes to Settings rather than starting one:
the estimate and the confirmation live there, and a rotation begun without seeing its cost
is the button nobody should have.
