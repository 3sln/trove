# 012 — Rotation retires a key while trashed ciphertext still needs it

A rotation walks the collection, re-seals what it finds, and retires the old key. It sources
that walk from `metadata.listItems`, which is live-only — `scan.js:94` says so in as many
words, *"`listItems` is live-only by design"*, and calls `trashedStorageKeys` for exactly
this reason. Rotation does not.

So the walk finishes having never seen the trash, concludes it is done, and deletes a key
that trashed objects are still sealed with. Restoring one afterwards fails permanently.

The file's own safety argument — *"IT FINISHES BY OBSERVATION… a pass that finds nothing
cannot be wrong"* (`rotation.js:22`) — is true of the set it observes and false of the set
that matters. Highest severity in the audit: it destroys data, silently, and the codebase
already solved this exact problem twenty lines away in another file.

## The findings

### Key rotation retires the old key while trashed items are still sealed with it — permanent data loss

`core/src/encryption/rotation.js:230` · high

I re-verified this one line by line. `#slice` sources all its work from `metadata.listItems`, which is `WHERE collectionId = ? AND deletedAt IS NULL`; `vfs.js:414` deliberately keeps the BYTES of soft-deleted items. So `finished = !cursor && !sawStragglers` is proof about a strict subset of the objects still sealed with the old key, and `retireKey` then does `delete keys[fingerprint]` — unrecoverable. Restoring an item trashed before a rotation completed throws 'encrypted with a key this collection no longer holds', forever. The file's own safety argument ('IT FINISHES BY OBSERVATION… a pass that finds nothing cannot be wrong', rotation.js:22) is falsified by the pass's scope, and scan.js:97 proves the codebase already knows `listItems` cannot see the trash — it calls `trashedStorageKeys` for exactly this reason. Rotation does not.

**Fix** — Make the pass observe the same set that keeps bytes: page live+trashed encrypted items in `#slice` (`listItems(..., { includeTrashed: true })` or a dedicated store method). A guard inside `retireKey` is the weaker fix — it leaves 'retire by observation' a false statement. No schema change; the trash is additive rows.

## Done when

Every finding above is fixed, or struck from this ticket with the reason it was wrong.
