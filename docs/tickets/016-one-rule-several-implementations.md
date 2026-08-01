# 016 — One rule, several implementations — and the copies have diverged

The audit's summary: *"this is where the real bugs are, and the pattern is uncannily
consistent: a comment declaring a single source of truth sits next to one copy while two or
three others exist elsewhere."*

This class has already shipped a bug once — `getDownload` and `mintUrl` encoded the same
presign-or-proxy rule and disagreed, so every thumbnail in an encrypted collection pointed
at ciphertext. The incident report is in this repo. They are still two rules.

## The findings

### Two file-icon classifiers: the launcher's list rows disagree with the grid about the same node

`web/src/bl/launcher.js:30` · medium

Two lenses, and I confirmed both renderers. bl/fileType.js's header exists specifically to end this: 'Previously the ext/mime lists were re-derived (and drifted) across openers.extOf, contributions.matchesSelector, iconForNode, and offline.isTexty; now the icon shown, the "is this text?" decision, and the type label all agree.' `iconFor` is a mime-only re-derivation defaulting to `file-text`; `iconForKind` matches extension OR mime and defaults to `file`. views/list.js:35 draws the launcher's value, views/grid.js:91 deliberately overrides it — someone already decided it was untrustworthy. So `report.pdf` is a text glyph in list and a generic file glyph in grid; `track.mp3` served as octet-stream is `file-text` in list and `file-audio` in grid.

**Fix** — Delete launcher.js:30-36, import `iconForKind` from './fileType.js', use it at :83. Grid's override then collapses to `it.icon`. Seven lines go.

### CollectionScanner's `#refresh` records the ciphertext size where `#adopt` deliberately records the plaintext size

`core/src/scan.js:249` · medium

`#adopt` reads the envelope under the comment 'The size the file has, not the size the envelope occupies' and records `envelope.plaintextSize` plus fingerprint/chunkSize; `#refresh` twenty lines later writes `object.size`, which for an encrypted object is plaintext + 44 header + 16 tag per chunk. It needs an encrypted object replaced in place behind Trove's back — which is precisely the scenario CollectionScanner's own header names as its reason to exist, and scan.js:225 calls sideloading 'a named use case here'. Once it happens the size is wrong forever in listings, quotas and collectionStats, and it feeds rotation, where `plaintextSize = node.size` bounds the read loop and is written into the new header.

**Fix** — In `#refresh`, when `node.encryption` is set, read the envelope via `#envelopeOf` and record `plaintextSize` plus fingerprint/chunkSize as `#adopt` does. Better: lift the shared body of `#adopt`/`#refresh` into one helper so the rule is written once.

### Rotation's two arms disagree about whether the record or the envelope is authoritative for plaintext size

`core/src/encryption/rotation.js:279` · medium

`#moveSlice` (multipart) takes `node.size`; the non-multipart arm 100 lines later takes `read.size ?? node.size`, which comes from the envelope header. vfs.js:631 already answers the authority question and answers it the other way, with the reason: 'it is a copy, and a copy can be stale: an object restored from a backup, adopted by a scan, or written by another version.' So which answer you get depends on whether the backend supports multipart. With a stale-large `node.size` the rotation raises 'Expected N bytes… received M' every slice and can never reach `done`, so the old key is never retired; with a stale-small one it seals a header that envelope.js:463 says 'decrypts to the wrong length forever'. Note the interaction with #18: `#refresh` is one way `node.size` becomes stale.

**Fix** — Decode the header once at the top of `#moveSlice` (or have `Vfs.readStream` hand the decoded header back) and take `plaintextSize` from it, so both arms say the same thing. One 44-byte read against multi-megabyte transfers.

### 'Encrypt this item, and with which key' is implemented twice, and the upload half fails open where the writeFile half fails closed

`core/src/vfs.js:124` · medium

The callback injected into UploadManager returns `null` when `dataKeyFor` misses; `#sealingFor`, the other implementation of the same question, throws 'This collection is encrypted but its key is unavailable'. A null policy makes the upload session plaintext, and `#assertSealed` — the guard built to stop exactly this — is gated on `if (s.encrypted)` so it never runs. The divergence is in the direction vfs.js:305 says must never happen: 'a server-side write put a READABLE file in a collection someone had set up to be encrypted.' Every future rule (per-principal, per-size, deny-list) has to be written twice.

**Fix** — Make `Vfs.#sealingFor(collectionId, name, contentType)` the single implementation and inject it into UploadManager as `sealingFor`, returning `{ key, fingerprint, chunkSize } | null`. UploadManager drops its `shouldEncrypt` import, its policy reach-through and its `#dataKeyFor`. `new UploadManager` appears exactly once, in the Vfs constructor.

### Optional-call `?.` on methods every implementation defines — the exact shape the repo documented as having caused a permanent silent no-op

`core/src/uploads.js:601` · medium

The repo has a written policy on this, at server/src/index.js:278: 'NOT `sidecar.sweep?.()` — that name did not exist on SidecarService, and the optional call turned "evict idle documents" into a no-op for the process's whole lifetime. It exists now, and the `?.` is gone so a rename shows up.' Contradicting instances: `this.sessions.expired?.(now)` (both stores define it, and this is the very call that comment wraps); `this.metadata.clearContribution?.()` at indexing.js:78 while :90 and :331 call it unguarded on a declared interface method; `settings.set?.()` twelve lines above an unguarded `notifications.error` from the same bag; a dozen `this.platform.notifications?.<kind>?.()` in bl/activity.js where platform/index.js constructs it unconditionally. The inconsistency inside single function bodies shows it is habit, not policy.

**Fix** — Drop the method-name `?.` wherever the method is part of a declared interface. Keep the OBJECT guard only where null is a real configuration — `this.issues?.` in sidecar/manager.js genuinely defaults to null — and drop the `?.` on the method after it. Hand-written test doubles for `sessions`/`notifications` will start failing loudly and need filling in; that is the point.

## Done when

Every finding above is fixed, or struck from this ticket with the reason it was wrong.
