# 025 — the audiobook player is a prototype, and one of its parts does not work

Observed on trove.raystubbs.me with plugin 0.4.0 installed, the node fully indexed
(`book`, 64 chapters, `thumbnail.range`, tags all present) and the Worker Loader bound.

## a. Play does nothing — the blocking bug

Pressing ▶ leaves the button on ▶, the seek bar at 0, and the time labels empty. Empty
labels are the tell: `labels()` only runs from `paint()`, which only runs from the
transport's `onTime`, so the audio element never fired a single `timeupdate` — it never
loaded. `transport.duration()` is 0, which is also why no duration is drawn anywhere.

The same file plays fine in the built-in viewer, which shows `13:39:06` and starts on
click, so the server and the bytes are not the problem. `/api/items/download?id=…` answers
`206` throughout.

What has not been established is WHY, and it needs the one thing this investigation could
not reach: the viewer runs in a `sandbox="allow-scripts"` frame on an opaque origin, so
its console and its `<audio>` element are not inspectable from the host page. The
hypothesis worth testing first is that an opaque-origin document cannot load the media URL
the way the host can — no credentials are sent from an opaque origin, and this drive is
behind Cloudflare Access — but that is a hypothesis, not a finding. **Test it by logging
`audio.error.code` and `audio.networkState` from inside the frame**, which is the only
place the answer exists.

### What the fix actually is

Not "make the frame's fetch work" — the frame should not be fetching a media URL at all.
Its only view of a file is a **remote blob**: an SDK handle that streams the slices it
needs on demand through the host, or asks the host for a download. Streaming and
downloading are then COUPLED rather than parallel — slices fetched for playback are kept
by the host as download progress, so listening to a book and keeping it offline are one
transfer instead of two.

Playback is fed from that: a **MediaSource** the frame appends slices to, with the `moov`
atom moved to the FRONT so the browser can start decoding without the index that normally
sits at the end of an Audible file. `mp4.js` already finds `moov` wherever it is and
`findMoov` reports `faststart`, so the pieces to do the relocation are in hand.

That also disposes of the opaque-origin problem by construction: nothing crosses an origin
boundary, because the frame never issues a request — the host does, and hands bytes over
the port it already owns.

### Instrumentation, and a limit worth knowing

`transport.js` now logs every terminal media state (`error` with a decoded
`MEDIA_ERR_*` name, `networkState`, `readyState`, `currentSrc`), `stalled`, and
`loadedmetadata` with the duration; `player.js` logs the media URL it was handed alongside
the frame's own origin.

**These could not be read from outside.** The Chrome extension's console reader returns
nothing for the viewer — it sees the top document, not a sandboxed child frame. Reading
them means DevTools with the frame selected in the context picker. That limitation is the
same one that made this bug invisible in the first place, and it is an argument for the
host logging on the plugin's behalf.

### A second, sharper reproduction

On the LOCAL dev drive the viewer does not merely fail to play — it hangs on
**“Opening…” indefinitely**, for a 441-byte m4b that is fully indexed. `mountViewer`
awaits `frame.channel.call('opener:open', …)` and shows `onReady` or the error; neither
fires, so the call never settles. That is a better starting point than the production
symptom, because it reproduces on a file small enough to reason about and needs no
Cloudflare Access in the picture.

## b. No cover art in the player

Not a bug so much as something never written: `player.js` renders a title, a byline, a
seek bar, five buttons and a chapter `<select>`, and nothing else. The cover is right
there — `metadata.thumbnail` carries a range into the file, and the grid already draws it
— so the player showing none is the odd one out.

## c. The controls are minimal, and the layout is wrong

Five monochrome buttons and a bare `<select>`. In the viewer pane the frame fills the
width while the content sits in a strip at the top, leaving most of the pane black — the
stylesheet was written for the compact docked case and never for the full-pane one.

There is no playback-rate control at all, despite `transport.rate` existing and the media
session already reporting it. For an audiobook that is a primary control, not a nicety.

## d. Recent tiles never get a thumbnail

Separate from the player, found alongside it. Under ALL ITEMS the tile renders
`<img class="gt-img" src="blob:…">` with the real cover; under RECENT the same file renders
`<div class="gt-media"><svg…>` and no `<img>`. `thumbnailOf` reads `node.contributions`, so
the likely cause is that the recents query returns nodes without them — worth confirming
against that query rather than assumed.

Also worth fixing while there: the cover appears seconds after the tiles paint, with no
placeholder, because each tile range-fetches ~58 KB through `fileChunks` after the list
renders. One book looks like a glitch; a page of fifty is fifty ranged requests.

## Note

The intended bar for this is a reference player Ray has in another repo — get that in front
of you before designing (a), (b) and (c), because "polished" here means something specific
and this ticket does not capture it.
