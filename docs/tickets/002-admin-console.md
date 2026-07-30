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

## Done when

There is one place an administrator goes, and the things that are currently only reachable
through `curl` are reachable through it.
