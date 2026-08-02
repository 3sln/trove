# 031 — "Reading the book's structure…" with no feedback, for a long time

Opening a 520 MB m4b (`the-quick-and-the-kept.m4b`) leaves the viewer on
`Reading the book’s structure…` with no spinner, no progress and no obvious end. It may
finish; it does not look like it will.

## What is actually happening

Measured against that file locally:

```
findMoov      2 reads, faststart: false, moov = 4.67 MiB
audioTrack    1,177,837 samples, 753 ms of straight CPU
total read    4.7 MiB
```

Three separate problems, and only one of them is speed.

**a. There is no feedback at all.** `player.js` draws `el('div', 'ab-status', …)` — static
text. No spinner element, no progress. Whatever the work costs, the screen says the same
thing throughout.

**b. The main thread is blocked.** `audioTrack` walks a million-entry sample table
synchronously — 753 ms on this machine, and several seconds on a slow one. Nothing
renders while it runs, so even a spinner would freeze. This is the part that makes it look
stalled rather than slow.

**c. It reads 4.67 MiB that it did not used to.** THIS IS A REGRESSION I INTRODUCED. Before
streaming, an indexed book opened from its contribution and read nothing at all. To stream,
`openBook` now probes for `moov` on every open — and a `moov` is large in proportion to the
book, because `stsz` carries four bytes per sample. On a non-faststart file that read is
also a tail read first.

## What to do

1. **Say what is happening.** A spinner at minimum; better, name the phase — reading the
   index, then reading the chapters — because those have very different costs.
2. **Get the table walk off the main thread**, or yield inside it. A million samples is not
   going to get smaller.
3. **Do not re-read `moov` on every open.** The sample tables are derivable from the file
   and change only when the file does — exactly what an indexer contribution is for. The
   indexer already opens `moov`; it could record what streaming needs (timescale, sample
   count, and the table offsets) so the viewer starts from the contribution and reads the
   tables only when it actually begins playing.
4. Failing that, at least **defer the probe until play is pressed**, so opening a book to
   look at its chapters costs nothing.

## Notes

- The parse is not the bottleneck by itself: 4.7 MiB and 753 ms. Over a slow link the read
  dominates; on a slow machine the walk does. Both need saying on screen.
- The SDK's RPC timeout is 30 s. A 4.67 MiB `files:bytes` on a poor connection can exceed
  it, and the failure then surfaces as `moovError` and a fallback to the download button —
  which is the right degradation but arrives after a silent half-minute.
