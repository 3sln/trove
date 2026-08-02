# Audiobook Player

Plays **M4B**, **LPF** and plain **AAC/M4A** audiobooks from the drive: chapters for both
of the first two, a dock so the book keeps playing while you browse, and OS transport
controls through the media session.

```
bun plugins/build.mjs audiobook
```

Then install `dist/audiobook-0.1.0.zip` through the plugin dialog, like any other plugin.

## What it reads, and what it does not

The interesting part is how little of a book it touches to open one.

**M4B** is one file with an index. That index — `moov` — is a few kilobytes somewhere
inside a few hundred megabytes, so the player reads a 64 KiB head window, walks the
top-level box chain by each box's own stated size, and reads `moov` where the chain says it
is. Chapters come from `chpl` (which almost every m4b in the wild uses) or from a text
chapter track. **No audio is read at all.** Playback is a minted URL the browser ranges
over itself, so seeking costs one request and nothing is buffered ahead of what is playing.

Whether `moov` can be found is what decides how much the player knows: if it cannot, the
file still plays end to end, and the player says so rather than pretending there are
chapters. If `moov` is at the END of the file — normal for an encoder that did not know the
final size — opening it reads the tail first, and the player says that too, because it
explains why opening took two round trips instead of one.

**LPF** is a zip of tracks plus a `publication.json`, and its tracks *are* its chapters. It
is read whole, which is the honest cost of the format: a zip's entries are not
independently addressable without reimplementing the central directory walk, and every
entry is audio anyway. Read once, held as frame-local object URLs, revoked on close.

**Plain AAC/M4A** has neither an index nor a manifest, so it is a one-chapter book. That is
not a degraded mode — the file really does have one chapter.

## `.aax` / `.aaxc`: not supported, deliberately

Audible's formats are the actual DRM, and the distinction from plain AAC matters: the audio
is **encrypted, not merely wrapped**, so there is nothing to hand a decoder without the key.
`.aax` needs activation bytes derived from the account that bought the book; `.aaxc` needs a
per-file voucher.

Both are obtainable for one's own library, and this player still will not do it. A
decryptor inside the viewer sandbox would mean key material living in a plugin frame and a
capability grant that reads as "play audiobooks" while meaning "hold the credentials to
your Audible account". The cheap and honest form, if it is ever wanted, is **convert on
import** — a file becomes an m4b before it enters the drive — which keeps key handling out
of the plugin and out of the drive entirely.

## Layout

```
manifest.json      identity, capabilities, and the contributes map
src/index.js       the background entry — deliberately empty; see the file
src/player.js      the opener: its own frame, its own document
src/book.js        one shape out of two containers
src/mp4.js         pure: boxes, moov, chapters, metadata
src/lpf.js         pure: publication.json, in every shape the spec allows
src/transport.js   playback as ONE timeline, whatever it is made of
test/              the two pure modules, byte by byte
```

`mp4.js` and `lpf.js` take bytes and return data — no browser, no drive, no plugin — which
is why they can be tested against constructed files that exercise the encodings a single
real book would hide: a 64-bit size, a to-EOF size, an index at the end, a zip nested one
level too deep.

## Capabilities, and why each one

- `files` — read bytes by range, mint a media URL, keep a book offline.
- `ui` — draw.
- `media` — the OS transport controls.
- `dock` — keep playing while the user navigates away.

It does **not** ask for `network` (it talks to nothing but the drive) or `storage` (it keeps
no database of its own). A capability nobody can justify in one line is one the review
dialog should not be asking someone to grant.
