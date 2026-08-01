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
remuxes server-side to guarantee it. We will not. Non-faststart files still play — the
browser range-fetches the tail to find `moov` — but the first seek is slow. Accept that and
say so in the UI; do not port a remuxer into a plugin.

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

## The thing to settle first: a viewer cannot get bytes

Checked against the SDK and its host handlers, and this blocks the whole port:

- `files:read` resolves `{ text: await api.readText(id) }` — **text**. There is no binary
  read for drive files. An m4b through that is not slow, it is corrupt.
- `files:downloadUrl` resolves `api.downloadUrl(id)`, a bare `/api/items/download?id=` URL
  carrying **no authorization**. A viewer runs in `sandbox="allow-scripts"` on an opaque
  origin, so it sends no cookies and cannot attach the `Authorization` header. On an
  authenticated drive that is a 401.
- `ctx.resources.read` does return bytes, but for *package* resources, not drive files.

So today an audiobook plugin cannot obtain its audio at all — and even if it could, pulling a
700 MB book into the iframe is not a design. Playback needs ranges and seeking, not a buffer.

The fix already exists in shape. `platform/mediaUrls.js` mints URLs for exactly this problem
— its header opens "URLs for things that cannot send a header … an `<img src>`, a
`<video src>`" — batched, with expiry and re-minting. Exposing that to viewer frames gives
`<audio src>` something that authenticates itself, seeks by range, and works through the
sealed path for encrypted collections, where ranged reads already go through `cipherRangeFor`.

One tension to resolve deliberately rather than by accident: the SDK header states that
plugins hold opaque handles and "never host URLs". That stance is about *package resources*,
and `files:downloadUrl` already departs from it for drive files. Decide whether minted media
URLs are a sanctioned exception for viewers — they are scoped and they expire, which is the
argument — and write it down where the next person will look.

## Done when

`plugins/*` exists with a documented build-and-package story and one plugin in it; that
plugin opens LPF and M4B audiobooks from the drive, streams them by range instead of buffering
them whole, shows chapters for both, keeps playing from the dock while the user browses, and
drives the OS transport controls through the media session. Plain AAC plays. `.aax`/`.aaxc`
is answered one way or the other in writing, even if the answer is "not supported".
