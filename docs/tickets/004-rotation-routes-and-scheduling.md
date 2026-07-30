# 004 — Rotation: routes and scheduling

`RotationService` is complete and tested: it mints a key, keeps the old ones live, walks the
collection in time-boxed slices with a persisted cursor, resumes across isolates, and
retires the old key when a pass finds nothing left on it. Nothing can start it. There is no
route, no command, and no cron slice.

## What is needed

**Routes.** Begin, read state, cancel. Admin-only, and admin-only in the sense
`requireHumanAdmin` means — an API key should not be able to re-key a collection.

**A cron slice.** `runMaintenance` already runs every five minutes on Workers and already
carries a budget it shares across collections. A rotation in progress should get a slice of
that, the way scans do. The service takes `budgetMs` for exactly this.

**Cost in front of the button.** `estimateRotationCost()` is written and unused. On R2 a
rotation is operations only; on S3 from outside AWS it is egress on every byte, which for a
large collection is a real bill.

## Notes

- `step()` claims the collection with a lease, so a cron slice and a manual run cannot race.
  Nothing needs to serialise them at the route.
- Rotation is idempotent: an object already on the current key is skipped. Re-running a
  slice is free, which is what makes a cron safe.
- A failed object leaves `failed > 0`, which correctly prevents retiring a key something is
  still sealed with. The UI should surface that rather than reporting the rotation as done.
- See 005 for the object-size limit this inherits.

## Done when

An admin can start a rotation, watch it progress across restarts, and see it retire the old
key — and a rotation left running finishes on its own from the cron.
