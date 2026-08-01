# 022 — A plugins directory, and its first tenant

Two pieces of work, and the second is the reason for the first: a `plugins/*` home in the
monorepo, and an audiobook player ported into it from [storia](https://github.com/3sln/storia).

Read the last section before starting either. There is a gap in the SDK that decides whether
the port is a week or an afternoon, and it is better known now than found halfway through.

## Part 1 — `plugins/*`

There are **no workspaces today**. `packages/` is a convention, not a declaration: the root
manifest has no `workspaces` field, the whole repo publishes as one package (`@3sln/trove`)
whose `exports` map into `packages/*/src`, and whose `files` lists four source directories.
So `plugins/*` is the first wildcard workspace this repo will have.

The distinction that matters, and the reason this is not just adding a glob: **a plugin's
artifact is not an npm package.** It is a signed zip that the server independently re-parses
(`core/src/plugins/package.js`), digests, and installs. `plugins/*` is therefore a *build*
location — each entry needs a manifest with its `contributes` map, a bundle step, and a zip
step — not a dependency graph.

Decide before writing one:

- Does a built plugin ship inside the npm tarball (`files` currently lists only source
  dirs), get published separately, or get built and attached to the GitHub release?
- Does the drive ship with any plugin preinstalled, or are these simply ours-and-installable?

There is **no example plugin anywhere in the tree** — not one `manifest.json` — so whatever
lands here first is also the reference every later plugin gets written from. Worth the extra
care in its layout and its README for that reason alone.

## Part 2 — the player

Storia is built on the same stack (`@3sln/ngin`, `@3sln/dodo`), which is what makes this a
port rather than a rewrite. Its player is ~2,950 lines of client code. What comes over is
determined by what each file imports:

**Ports nearly intact**

- `player/bl/player.js` (749) — imports `@3sln/ngin` and one pure local module. Nothing else.
- `shared/lpf.js` (188) — pure by design and says so in its header, so it can be unit-tested
  as-is.
- `shared/chapterSync.js` (62) — pure, deterministic, already tested.
- `shared/idb.js` (107) — offline storage.
- `player/ui/compositions/playerApp.js` (694) — dodo.

**Must be rewritten**

- `player/providers/resources.js` (290) — ngin resources bound to storia's own API. In a
  plugin these become the SDK: `ctx.files`, `ctx.settings`, `ctx.storage`.
- `jszip` → **fflate**, which this repo already depends on and already uses to unzip plugin
  packages. No reason to carry a second zip library into a sandbox.
- `epubjs` and `player/ui/reader/epubReader.js` (537) — read-along against an ebook. That is
  storia's model, not the drive's. Leave it out deliberately rather than port it by accident;
  it is half the UI weight and none of the ask.

## Docking and the media session — already built, both ends

This part is hookup, not construction. The manifest declares the capabilities (`media` and
`dock` are both already in `ALL_CAPABILITIES`) and the plugin calls:

- `ctx.dock.enable(opts)` / `disable()` / `close()`, with `onDock` notified on state change.
  Opener contributions already accept a `dock` option in their declaration.
- `ctx.media.setMetadata / setPlaybackState / setPositionState / setActionHandler` →
  `MediaController` → `navigator.mediaSession`, so the OS lock screen, media keys and
  notification shade drive playback. The last frame to touch it owns it, and its handlers are
  released on teardown.

`FrameDock` is worth reading before wiring it, because its central constraint is exactly the
one an audiobook needs: a frame's iframe is created once and **never re-parented**, since
moving an `<iframe>` in the DOM reloads its document and would kill the running plugin
mid-sentence. It is floated as a fixed overlay tracking a target box instead. That is what
lets someone browse the drive while the book keeps playing — which is the whole point of
using the dock rather than an in-page player.

## Formats

**LPF** — the easy half, and the half storia already solved. Zip plus a `publication.json`
manifest (`application/lpf+zip`), and `shared/lpf.js` handles the schema.org shape-wrangling
already. One thing to decide once: in a *drive*, is a book a single `.lpf` file or an
unpacked folder of tracks beside a manifest? The opener's `match` differs (ext/mime versus a
folder convention), and the folder form is natural here in a way it never was against
storia's R2 object model.

**M4B** — the hard half, and **not a port**. Storia extracts chapters with **ffmpeg running
in a Cloudflare Container**; its player simply consumes `data.chapters` from the API. A
plugin has no ffmpeg and no server side. Chapters have to be parsed in the browser from the
MP4 atoms (`moov`, `chpl`, or a chapter text track). There is good precedent in storia
itself: `worker/lib/mp4-faststart.js` walks atoms with no ffmpeg and no decode, holding only
`moov` in memory.

The second m4b problem is seeking: it wants `moov` before `mdat` ("faststart"), and storia
remuxes server-side to guarantee it. We will not — see **Probing for `moov`** below, which
is how a book earns the right to stream instead of being downloaded first.

**AAC, and the DRM question** — the word covers two different things and they have opposite
answers:

- Plain `.aac`/ADTS and `.m4a`: no DRM at all. Plays in `<audio>` directly, costs almost
  nothing to support. Usually no chapters, so it degrades to a one-track book.
- Audible `.aax` / `.aaxc`: this is the DRM. The audio is **encrypted, not merely wrapped**,
  so "ignore it" is not on the table — without the key there is nothing to hand a decoder.
  `.aax` needs activation bytes derived from the account that bought the book; `.aaxc` needs
  a per-file voucher. Both are obtainable for one's own library.

Recommendation: ship plain AAC alongside LPF and M4B, and treat `.aax`/`.aaxc` as a separate
decision. If it is wanted, the cheap and honest form is **convert on import** — a file
becomes an m4b before it enters the drive — rather than a decryptor living inside the viewer
sandbox. That keeps the key handling out of the plugin and out of the drive.

## A viewer cannot get bytes — the gap under all of this

Checked against the SDK and its host handlers. Nothing else in this ticket can be built
until it is closed:

- `files:read` resolves `{ text: await api.readText(id) }` — **text**. There is no binary
  read for drive files. An m4b through that is not slow, it is corrupt.
- `files:downloadUrl` resolves `api.downloadUrl(id)`, a bare `/api/items/download?id=` URL
  carrying **no authorization**. A viewer runs in `sandbox="allow-scripts"` on an opaque
  origin, so it sends no cookies and cannot attach the `Authorization` header. On an
  authenticated drive that is a 401.
- `ctx.resources.read` does return bytes, but for *package* resources, not drive files.

So today an audiobook plugin cannot obtain its audio at all — and even if it could, pulling a
700 MB book into the iframe is not a design. Playback needs ranges and seeking, not a buffer.

Two ways to close it, and we are taking the second.

**Minted URLs.** `platform/mediaUrls.js` already mints self-authorizing URLs for exactly this
problem — its header opens "URLs for things that cannot send a header … an `<img src>`, a
`<video src>`". Hand one to the sandbox and `<audio src>` streams natively: the browser does
its own range requests, seeking is free, and no format work is needed. The cost is that the
sandbox now holds a host URL, against the SDK's stated rule that plugins hold only opaque
handles. Keep this in mind — it is the escape hatch if the format work below proves too deep.

**A Blob (chosen).** `Blob` is already the browser's interface for "bytes I can address
without holding them": `slice()` is free, `stream()` is a reader, and everything that eats
bytes eats a Blob. So the range reader wears the interface that already exists rather than
inventing a parallel vocabulary, and no host URL crosses into the sandbox.

## RemoteBlob

`class RemoteBlob extends Blob`, constructed by the SDK, fetching ranges over the port the
frame already holds. `ctx.files.blob(id)` returns one. Surface:

- `size` / `type` / `etag` — `etag` refreshed from every read, because a file overwritten in
  place keeps its id, and anything cached off these bytes has to notice.
- `slice(start, end)` — a window on the same source. No bytes move and none need to exist.
- `stream()`, `bytes()`, `arrayBuffer()`, `text()`, and a `chunks()` async iterator.
- `local({ onProgress, signal })` — **realize** the bytes into an ordinary Blob.

Two host-side pieces it needs: `api.readRange(id, {start, end})` returning
`{bytes, etag, total}` (half-open `[start, end)`, converted to HTTP's inclusive range at that
one boundary; `total` parsed from `content-range`), and a `files:bytes` RPC method that
capability-gates it and returns the bytes as a transferred buffer.

**The sharp edge, and it is sharp.** A Blob *subclass* only overrides what JavaScript calls.
Anything reading the blob's INTERNAL bytes — `URL.createObjectURL`, `new Response(blob)`,
`fetch(url, {body})`, and **structured clone through `postMessage`** — bypasses the overrides
entirely and sees the empty blob passed to `super()`. Two consequences to design around:

1. A RemoteBlob cannot be posted into the sandbox from the host; it would arrive as a plain,
   empty Blob. It is constructed **inside** the frame that uses it.
2. `local()` is the escape hatch for all of them: a realized Blob really does hold its bytes,
   so it works with `createObjectURL` — which is precisely the download-then-play path for a
   book that cannot be streamed.

## Offline, and where a chunk comes from

A read should prefer whatever local copy already exists. Three answers, in order:

1. **A pinned whole-file copy.** `bl/offline.js` already pins: it fetches with a minted URL
   and `cache.put`s the whole Response into Cache Storage (`trove-files-v1`), keyed on the
   *stable* `mediaUrls.cacheKey(id)` rather than the minted URL, so `unpin` can find it
   again. Slicing that cached Response's Blob is disk-backed and costs nothing — a pinned
   book plays with the network off, and this comes almost free.
2. **Chunks of a download in progress.** Playing from the middle fetches the middle. If that
   file is *also* being taken offline, those bytes are worth keeping, so the read contributes
   them to the store and the background filler skips them later.
3. **The network**, keeping nothing.

The third case is the default and the one that matters most: a plugin ranging over a file
nobody asked to keep must not quietly fill the disk with it. **Bytes are retained only for an
item someone has actually asked to have offline** — `start(id)` is that asking, and until it
is called this is a plain ranged reader. That was the explicit requirement and it is the rule
the whole design hangs off.

Sketch: a `FileChunks` service in `platform/`, fixed chunk size (4 MiB — a long book is a few
hundred entries, not a few thousand), chunks in their own cache keyed
`${downloadUrl(id)}#chunk=${etag}:${chunkSize}:${index}`. **The etag is in the key**: a file
overwritten in place keeps its id, so an id-keyed cache would hand a viewer the head of the
old file and the tail of the new one — for a container format that is a parse failure, and a
confusing one. On a changed etag the old chunks stop matching and get swept.

`start(id)` marks the item as kept and runs a background filler over the missing chunks in
order; it must be idempotent, so starting a running download returns its status rather than
racing a second filler over the same chunks. Plus `status(id)`, `cancel(id)`, and `remove(id)`
(cancel and reclaim).

The natural flow this enables, and the one the player should use: **starting playback starts
the download.** From then on every chunk is checked locally first and fetched only on a miss,
so a book listened straight through downloads itself exactly once, and a book skipped around
in fills its gaps in the background.

## Download progress

The SDK needs to both trigger and monitor a download, so a viewer can show a real progress
bar and a Download button for anything that cannot stream. Two levels, and the plugin picks:

- `RemoteBlob.local({ onProgress, signal })` — a one-shot download into memory. `onProgress`
  gets `{loaded, total, ratio}` after each chunk **and once with `loaded: 0` before the
  first**, so a bar can appear at 0% instead of jumping in partway. `signal` cancels between
  chunks.
- `ctx.files.offline.{start,status,cancel,remove}` plus progress events pushed to the frame —
  a durable download that survives the viewer closing, which is what "make this available
  offline" means as opposed to "fetch it so I can play it now".

## Probing for `moov`

**Whether we can locate `moov` is what decides streamable versus download-first**, so the
probe runs before playback and its answer drives the UI.

Best effort, cheap, and local. Read a head window and a tail window, then walk the top-level
box chain: each box header gives its own size, so the next header's offset is known and can
be read 16 bytes at a time — no scanning. Handle the 64-bit form (`size == 1` → `largesize`)
and the to-EOF form (`size == 0`). Most files answer from the head and tail windows alone
without a third request. If the chain breaks, fall back to scanning the tail window for a
`moov` signature, validating a candidate by checking that the size in front of it lands
exactly on EOF or on another plausible box header — that validation is what keeps a scan from
returning garbage.

Result: `{found, offset, size, faststart, via: 'chain'|'tail-scan'}`. Cache it **keyed by
etag**, same reasoning as the chunk store — a re-uploaded file must re-probe rather than
seek into a layout that is no longer there.

Storia's `worker/lib/mp4-faststart.js` is a direct donor: `readBox`, `planFaststart` (which
already walks exactly this chain), `patchMoovOffsets`, and `faststartChunks`. Note why
patching exists — relocating `moov` shifts every media chunk, so `stco`/`co64` offset tables
inside it have to be corrected by the delta or every sample points at the wrong bytes.

**The open risk, which needs proving before the rest is built.** Finding `moov` gets us the
sample tables, which is what makes time → byte-range mapping possible. But a Blob is not a
URL, so there is no `<audio src>` to hand it to; feeding a player progressively means Media
Source Extensions, and **MSE does not accept a progressive MP4** — it wants fragmented ISO
BMFF (`moof`+`mdat` segments after an init segment), and a normal m4b is one `moov` plus one
`mdat`. So streaming through the Blob path means fragmenting in the browser (mp4box.js does
this; it is a real dependency and real work).

Prove that end first with one file. If it turns out too deep, the minted-URL option above
buys native streaming with no format work at all, and the moov probe is still what tells the
user which of the two they are getting. Either way the fallback is the same and is worth
shipping first because it always works: `local()` with progress, then an object URL.

## Done when

`plugins/*` exists with a documented build-and-package story and one plugin in it; that
plugin opens LPF and M4B audiobooks from the drive, streams them by range instead of buffering
them whole, shows chapters for both, keeps playing from the dock while the user browses, and
drives the OS transport controls through the media session. Plain AAC plays. `.aax`/`.aaxc`
is answered one way or the other in writing, even if the answer is "not supported".

And underneath it: a viewer can read a file's bytes by range without a host URL; a book that
cannot be streamed offers a Download button with real progress; a book being kept offline is
fetched exactly once whether the listener plays it straight through or skips around; and a
file nobody asked to keep leaves nothing behind on disk.
