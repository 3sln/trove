# 025 — streaming a book that is not downloaded

Everything else on this ticket is done. What is left is one thing, and it is the piece
that needs a decision as much as an implementation.

## What was fixed

**Play did nothing** — because the frame's CSP is `connect-src 'none'` and
`media-src blob: data:`, deliberately, so a viewer cannot reach the network and cannot be
an exfiltration side-channel. `<audio src="https://…/api/items/download?id=…">` was blocked
outright, and `ctx.files.mediaUrl()` hands the frame exactly that — an API that could never
have worked where it was used.

Media now arrives as bytes: `files.hasLocal(id)` and `files.localBlob(id)`. A downloaded
book plays from its own Blob; one that is not offers a download with progress and reopens
itself through the ordinary path when the bytes land.

**Cover art, controls, layout, recents** — all done. The cover is one ranged read of bytes
the contribution already points at, resolved to a `blob:` URL. Playback rate is a control
rather than a field only the media session knew about. The panel centres in a pane instead
of clinging to the top edge. Recent tiles carry their thumbnail descriptor, because a
recents entry is a snapshot in localStorage and nothing re-reads the node.

## What is left: streaming without downloading first

A book that is not on the device can only be downloaded whole. It should be possible to
press play and start listening.

**Why it is not just "point MediaSource at it".** MSE takes FRAGMENTED MP4 — an
initialisation segment (`ftyp` + `moov` carrying `mvex`) followed by `moof`+`mdat` media
segments. An `.m4b` is progressive: one `moov`, one enormous `mdat`, no `moof` anywhere.
`appendBuffer` on those bytes fails however they are ordered, so moving `moov` to the front
makes the file seekable without making it appendable.

**So it needs a transmuxer**, in the frame: read the sample tables (`stts`, `stsc`, `stsz`,
`stco`/`co64` — `mp4.js` already parses every one of them), synthesise an init segment with
`mvex`, and wrap ranges of `mdat` into fragments on demand. Constant memory, seek anywhere,
first audio after a few hundred kilobytes.

**Explicitly rejected:** fetching the whole file and assembling a rearranged Blob in
memory. It is fifty lines and it works, and it holds a 185 MB book in RAM and cannot start
until the last byte arrives — which is the buffering the ranged design exists to avoid.
If the transmuxer cannot handle a given file, the answer is the download button that is
already there, not a worse stream.

## Notes

- The bytes come through the remote blob (`ctx.files.blob(id)`, sliced), so the host does
  the fetching and the frame never issues a request. Slices fetched for playback should
  count as download progress — one transfer, not two — which is the coupling that makes
  "listen now, keep it offline" a single act.
- A sandboxed frame's console is not readable from the host page, and the extension's
  console reader returns nothing for it. `transport.js` logs every terminal media state;
  reading them needs DevTools with the frame selected. Worth making the host forward frame
  errors so this is not true next time.
- Watch for a service worker pinning an old shell during local testing — it caused hours
  of "the fix did not take" in this ticket's investigation. `caches.delete` + unregister.
