# 001 — Encryption admin UI

Encryption is complete on both sides: the client seals before a presigned PUT, the server
decrypts on the way out for everything that reads through it, rotation moves a collection
onto a new key without anything going dark. None of it is reachable from the app. The only
way to enable encryption on a collection is a hand-written `PATCH` to the collections API.

That is the gap between "works" and "can be offered".

## What is missing

**Turning it on.** The collection dialog needs an encryption section: enable, and the rules
that decide which items get sealed — all files, or by extension, or by media type. The
server already refuses a configuration that would match nothing (`normalizeEncryption`),
so the form should say why rather than letting the API do it.

**Saying what it does and does not do.** `describeExposure()` exists and returns exactly
this: that files are sealed before reaching the storage provider, that it is not
end-to-end, that anything indexing a file reads it in the clear, and which indexers can
send content off the drive. It should sit next to the encryption toggle rather than in a
help page — the moment someone turns this on is the moment the scope matters.

**Rotation.** Start it, watch it, see it finish. `estimateRotationCost()` should be in
front of the button, since on a metered store this is a real bill (see 004 for the routes
this needs).

**The key fingerprint**, somewhere findable. It is the only thing that identifies which key
a collection is on, and it is what a sideloaded object is matched against.

## Notes

- The collection form already renders from `/api/capabilities` descriptors rather than a
  hardcoded list — encryption settings should follow the same pattern.
- There is no unlock prompt and no locked state, deliberately: the server holds the key and
  hands it to anyone allowed the collection. Do not build one.
- Enabling encryption affects only what is uploaded afterwards, and disabling it decrypts
  nothing. Both need to be said in the UI, because both are surprising.

## Done when

An admin can turn encryption on for a collection, choose what it covers, see what it
protects and what it does not, and never needs to touch the API to do it.
