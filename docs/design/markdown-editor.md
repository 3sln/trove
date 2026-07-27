# Editing a document in place

Notes for when the markdown editor gets built. Nothing here is implemented yet; this
records the decisions already made and the two facts about the existing code that make
them cheap, so neither has to be rediscovered.

## Saving goes through the ordinary upload

There is no separate write-content route and there should not be one. `POST /api/uploads`
with `overwrite: true` → parts → `complete` is the save path.

The reason it works, which is not obvious from the outside: `Vfs.#upsertItem` with
`overwrite: true` calls `metadata.update(existing.id, …)` rather than creating a new
record. **The node id survives a save.** Comments, tags, backlinks, subscriptions and
offline pins all stay attached to the document through an edit. A save that minted a new
id would quietly orphan every one of them, and that is the failure this avoids.

For a document-sized file the upload is `create → PUT one part → complete`. The
round-trip count is not the thing to optimise; the save cadence is.

## Save cadence

Debounced, not per keystroke. Plus a forced save on:

- closing the editor panel
- `visibilitychange` to hidden, and `pagehide` — the two the browser actually gives you
  before a tab goes away. `beforeunload` is not reliable on mobile.

Track the time of the last successful save. An edit made offline replays on reconnect;
between two offline edits of the same document, last write wins, and the timestamp is
what decides.

## Conflict is detected by etag, not by hope

Last-write-wins is right for replaying one person's offline edits. It is wrong when the
document changed underneath them — another device, another user, a scan that adopted a
newer copy from the bucket.

So the editor remembers the `etag` of the content it loaded, and the save carries it as a
precondition. If the stored etag no longer matches, the save is refused and the user
chooses:

- **Replace** — my version wins
- **Reload** — throw mine away and take theirs
- **Save as a different file** — keep both

Asking is the point. Silently picking either side loses work that somebody typed.

### What this needs from the server

The check has to be server-side. A client that reads the etag, compares it, and then
saves has a window between the read and the write, which is exactly the case the guard
exists for.

Two small changes, both following a path that already exists:

1. `createUpload` accepts `ifMatch`. The session already carries `overwrite` from
   negotiation through to completion (`obj.overwrite` in `completeUpload`), so this
   rides along the same way.
2. `#upsertItem` compares `existing.etag` against it and throws
   `TroveError.conflict` when they differ — which the client already renders as a 409.

Node records already carry `etag` (see `metadata/interface.js`), and it reaches the
client on `/api/items/resolve`. Nothing new has to be stored or plumbed.

Note that the `etag` the client handles during a multipart upload is a **part** etag from
the storage backend. It is not the node's etag and the two must not be confused.

## The editor itself

Prefer an existing, extensible library over writing one. The extension points that matter
are the two things this drive is built around:

- **`@mentions`** — the sidecar already resolves mentions and routes notifications, so
  the editor only needs to produce the same markup the comment composer does.
- **`trove:` item links** — autocomplete over the drive, inserting the URI form the
  markdown opener already renders as a clickable link (`links.js`, `parseTroveUri`).

An editor that cannot be taught those two is the wrong editor, however good it is
otherwise.
