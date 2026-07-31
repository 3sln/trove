# 010 — Direct reads cost two round trips and a plan each

Encrypted collections now read straight from the store: the service worker fetches a
download plan, gets a presigned URL and the collection's data key, pulls ciphertext from the
bucket and decrypts it before handing plaintext to whatever asked — including an `<img src>`
that has nowhere to run our code. The bytes stop touching the drive, which is the point.

What it costs per object is worse than it needs to be.

## Two GETs where one would do

The 44-byte envelope header is read first because it is authoritative: the item record's
copy of `chunkSize` and `fingerprint` can be stale (an object restored from a backup,
adopted by a scan, written by an older version), and deriving byte ranges from one layout
while decrypting against another surfaces as "the data has been altered" on data nobody
altered.

But for a FULL read the header is simply the first 44 bytes of the object, and a full read
starts at byte 0 anyway. Fetching `bytes=0-43` and then re-fetching from `44-` is waste with
nothing bought: peel the header off the front of one stream instead. No schema change, works
on objects already in a bucket.

A RANGED read is the one that genuinely needs something it does not have. The range
arithmetic needs `chunkSize` and `plaintextSize`, both already in (or derivable from) the
plan. `noncePrefix` is the exception — eight bytes that exist only in the header, and
decryption cannot proceed without them.

## A plan per object, for a key per collection

The endpoint fuses two things whose lifetimes are nothing alike:

- the **key**, a property of the COLLECTION, one per fingerprint, changing only on rotation
- the **URL**, a property of the OBJECT, expiring, per item

So a gallery drawing a hundred thumbnails fetches a hundred plans for a key it already holds.
`mediaUrls` already batches per-object URL minting because per-object round trips do not
scale; this endpoint reintroduced exactly that problem one layer down.

Roughly, for a hundred thumbnails: ~300 requests today against ~101 with the key cached and
the header folded in.

## The thread question, unmeasured

Decryption happens on the service worker's single thread, shared with every other fetch the
app makes. Worth separating two costs before restructuring anything: the AES itself is
`crypto.subtle.decrypt`, AES-NI accelerated and executed off the JS thread in Chrome and
Safari, while what actually runs on the worker thread is stream plumbing — a TransformStream
hop and a promise per 1 MiB chunk. At 25 Mbps that is about three chunks a second.

The suspicion is that request count dominates and CPU does not, but that is a guess, and the
change it would justify is large enough to deserve a measurement first.

## The work, in the order it pays

1. ~~**One GET for a full read.**~~ Done. The header is peeled off the front of the single
   body fetch. A ranged read still costs two — see 3.
2. ~~**Cache the plan.**~~ Done, and better than the split this originally proposed: the plan
   carries `expiresAt`, and the worker holds URL and key together per node id. Splitting key
   from URL would have saved nothing on its own, because the URL is per-object and still
   needs a call; holding both is what removes the round trip. A scrubbing `<video>` now
   costs no traffic to the drive at all.
3. **Persist `noncePrefix`** (8 bytes) on the item record at upload, so a ranged read is one
   GET too. Objects without it fall back to reading the header, and a scan can backfill —
   this is a metadata migration and wants its own change.
4. **Instrument the worker** before touching the threading model. If it is hot,
   `ReadableStream` is transferable (Chrome 89+, Safari 16.4+), so ciphertext can go to a
   dedicated worker pool with in-worker decryption as the fallback.

Cheap and independent of all four: cache decrypted bytes in the existing `trove-files` cache
for recently read objects. Not a new privacy posture — offline pinning already stores
plaintext locally, because `pinnedFirst` caches the decrypted response.

## A lever, if 2 and 3 are not worth it

Read direct only above a size threshold. The overhead is fixed, so it is irrelevant against a
2 GB video and dominant against a 4 KB thumbnail, and proxying the small ones costs little.
Worth knowing about; not the plan, because 1–3 make the threshold unnecessary.

## What is left

3 and 4 above, plus the batching that 2 turned out not to need for the repeat case but which
still applies to the FIRST read of each object in a large gallery: a hundred cold tiles are
still a hundred plan requests. Coalescing them the way `mediaUrls` coalesces minting is the
remaining win, and it is only worth doing if a real library shows it matters.

## Done when

An encrypted object costs one round trip to the bucket and no per-object call to the drive,
and a gallery of a hundred thumbnails does not fetch a hundred keys.
