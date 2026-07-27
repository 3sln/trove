# Signed URLs

A URL that carries its own authorization, so something that cannot send an
`Authorization` header can still fetch one object.

## Why this is one primitive and not three

It was built once, inside the indexer runtime, as `ctx.file.presignRead()` — and only
the S3 half of it. On a filesystem or NAS collection it throws `unsupported`. The other
callers that need the same thing were never connected to it, and each broke in its own
way instead:

- **`<img>` / `<video>` / `<audio>` openers** set `src` to `/api/items/download?id=…`,
  which needs a header a subresource load cannot send. Under bearer-token auth every
  preview 401s and falls back to "this file couldn't be loaded".
- **Offline pinning** does `cache.add(downloadUrl(id))`, an unauthenticated fetch. Same
  401, so pinning is silently broken in the same deployments.
- **Remote indexers on non-S3 backends** get the `unsupported` throw, which removes the
  whole "hand the file to an external API" story from every self-hosted NAS.

Three symptoms, one missing primitive. So it is a service, and `presignRead` becomes one
of its callers rather than its owner.

## Two implementations, one contract

```
signedUrls.mint(node, { op, expiresIn }) -> { url, expiresAt }
```

- **Backend can presign** (S3/R2) → `storage.presignGet(key, …)`. Bytes never touch the
  server.
- **Backend cannot** (filesystem, memory, NAS) → the server mints its own:
  `/api/items/download?id=…&exp=<unix>&sig=<hmac>`, an HMAC over `(id, op, exp)` with a
  server secret.

Both are **stateless with the expiry baked in** — nothing to store, nothing to revoke,
nothing to clean up. They simply stop verifying at `exp`.

The signature is a grant, not a hint: a request carrying a valid one gets a read handle
for that one node without a principal, because the signature was minted by someone who
held `read` at the time. Guardrails: single object, read-only, TTL capped server-side,
and the signature covers the id so a valid one for a file you may see cannot be edited
into one for a file you may not.

## TTL is per purpose, and content URLs are long

| purpose | default | max | why |
| --- | --- | --- | --- |
| `index` | 5 min | 15 min | handed to an external API that fetches it once, promptly — and then it is outside our control, so it should stop working |
| `download` | 2 h | 12 h | a stalled browser download that resumes must not find its URL dead. Validated when the transfer STARTS, so an in-flight 4 GB transfer finishes regardless |
| `media` | 12 h | 24 h | a `<video>` re-requests on every seek, so this outlives the SITTING — a long film, an audiobook session, an evening of episodes |

A 15-minute media URL is not a rare small bug; it is a film that stops forty minutes in,
which is the worst way for this to fail. Content URLs are long deliberately.

**The cost, stated plainly:** a stateless signature cannot be revoked. Remove someone's
access to a collection and their outstanding media URLs keep working until they expire —
up to a day. This is exactly the property an S3 presigned URL has, so the self-signed
path is no worse than the S3 path it stands in for, and both are no worse than the file
already being in that person's browser cache.

If that ever needs closing, the cheap version is a revocation epoch: a counter in the KV
store, included in the signed payload, bumped when a collection's ACL changes. It costs
one KV read per verify and trades the "nothing to look up" property for the ability to
cut URLs off. Not built, because nothing has asked for it.

## Cycling, which is the part that gets skipped

A URL that expires must be replaced *before* it is needed again, and replacing it under a
playing media element is not a matter of assigning `src`.

**Both paths are required**, because either alone leaves a hole:

- **Proactive**: a timer set from `expiresAt`, firing at ~80% of the TTL. Handles the
  common case with no user-visible failure.
- **Reactive**: the media element's `error` event, and an `<img>`'s. A backgrounded tab
  has its timers throttled, so the proactive refresh may simply never run — someone who
  pauses a film, closes the laptop, and comes back three hours later gets the reactive
  path or nothing.

**Swapping the URL under a playing element** means, in order:

1. Record `currentTime` and whether it was `paused`.
2. Set the new `src` and call `load()` — assigning `src` alone does not reliably restart
   a media element that has already errored.
3. On `loadedmetadata`, restore `currentTime`.
4. If it was playing, `play()`.

Skipping (1) restarts the film from the beginning. Skipping (3) is the same bug wearing a
different hat. Skipping (4) leaves it paused with no explanation, which reads as a crash.

For an `<img>` there is no state to preserve — re-mint and reassign — but it must be
**once**, not a retry loop: a tile whose object is genuinely gone would otherwise re-mint
forever.

## The grid, and not minting 200 URLs one at a time

A gallery draws hundreds of tiles. Per-object minting is right for scoping and wrong for
round trips, so minting is **batched**: the client asks for the ids it is about to draw
and gets a map back. Per-object signatures, one request.

## What must not regress

Offline pinning keys its cache on the URL string — `cache.add(url)` on pin,
`cache.delete(url)` on unpin, and the service worker matches cache-first on request URL.
A URL that changes every time it is minted cannot be that key. The cache key and the
fetchable URL have to be separate things, or unpin silently stops matching and pinned
bytes are never reclaimed.
