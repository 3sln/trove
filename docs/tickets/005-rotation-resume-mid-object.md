# 005 — Rotation: resume mid-object

A rotation slice is bounded by wall-clock budget and resumes **between** objects: the cursor
records how far through the collection it got. It cannot resume **within** one. An object
large enough to exceed the budget on its own fails its slice, is retried from the beginning
on the next, and fails again — forever, with the rotation never completing and the old key
never retiring.

Memory is no longer the constraint (rotation streams through multipart, one part resident),
so this is purely about time.

## Where the line falls

The budget defaults to 15s per slice and a cron firing gets 20s. What fits depends on the
store's throughput and on AES-GCM over the whole object, so there is no fixed size — but a
multi-gigabyte video will not fit, and a collection containing one will never finish
rotating.

## What resuming would take

The part list is the natural checkpoint: a multipart upload already produces parts in order
with their etags, so a slice could record `{ uploadId, parts, nextChunk }` alongside the
cursor and continue rather than restart. Two things to be careful of:

- **Nonces come from chunk position**, so a resumed encryption must continue the same
  sequence with the same nonce prefix, not start a fresh envelope. That state has to be
  persisted with the part list.
- A multipart left open across slices is billed until completed or aborted, so an
  abandoned rotation needs sweeping the way abandoned upload sessions already are.

## Interim mitigation

Detect it rather than loop: if an object fails its slice twice in a row, record it as a
standing issue naming the file, and let the rotation finish the rest. A collection with one
enormous file should not be prevented from rotating everything else.

## Done when

A collection containing an object larger than one slice can complete a rotation.
