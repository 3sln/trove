// Playing a book that is not on this device.
//
// The frame cannot fetch and cannot be handed a URL — `connect-src 'none'`,
// `media-src blob: data:` — so audio arrives as bytes over the port and reaches the
// element through a MediaSource, whose object URL is a `blob:` and therefore allowed.
//
// MediaSource takes FRAGMENTED MP4 and an m4b is progressive, so every appended byte is
// built by `transmux.js` from the sample tables plus a ranged read of the original audio.
// Nothing is re-encoded: a fragment's `mdat` is a copy of the file's own bytes.
//
// What this buys over the download path is the whole point of ranged reads — audio starts
// after a few hundred kilobytes rather than after the whole book, and seeking to hour
// eleven reads hour eleven.

import { audioTrack, initSegment, mediaSegment, windowAt, mimeOf } from './transmux.js';

/** How much audio to keep ahead of the playhead, and how much to fetch at a time. */
const WINDOW_SECONDS = 20;
const AHEAD_SECONDS = 30;

/**
 * Can this book stream here?
 *
 * Answered before anything is drawn, because the alternative — a play button that turns
 * out not to work — is what this whole ticket was about. A `null` means "offer the
 * download instead", which is a real answer rather than a failure.
 */
export function canStream(moov, moovError) {
  // Every `no` carries a REASON, and the reason reaches the screen. "Download to play"
  // with no explanation is the same dead end as a play button that does nothing — the
  // person looking at it cannot tell whether their book is unusual, their browser is, or
  // something is broken.
  if (typeof MediaSource === 'undefined') return { why: 'this browser has no MediaSource' };
  if (!moov) return { why: moovError ? `its index could not be read — ${moovError}` : 'its index could not be read' };
  let track = null;
  try { track = audioTrack(moov); } catch (err) { return { why: `its sample tables could not be read (${err.message})` }; }
  if (!track) return { why: 'it has no audio track this can fragment' };
  const mime = mimeOf(track);
  // The decoder gets the final say. A book this can describe but the browser cannot play
  // must fall back rather than append into a source buffer that will never accept it.
  if (!MediaSource.isTypeSupported?.(mime)) return { why: `this browser cannot play ${mime}` };
  return { track, mime };
}

/**
 * A `blob:` URL an <audio> can play, fed on demand from `read(start, end)`.
 *
 * Returns `{ url, dispose }`. `dispose` must be called when the viewer closes: it stops
 * the feeder and revokes the URL, and without it a closed book keeps fetching.
 */
export function streamUrl({ track, mime }, read, { onError } = {}) {
  const media = new MediaSource();
  const url = URL.createObjectURL(media);
  let buffer = null;
  let closed = false;
  let busy = false;
  let appendedTo = 0;      // samples appended so far, as an index
  let audio = null;        // set by `attach`, so the feeder knows where the playhead is

  const fail = (err) => { if (!closed) onError?.(err); };

  media.addEventListener('sourceopen', () => {
    if (closed) return;
    try {
      buffer = media.addSourceBuffer(mime);
      buffer.mode = 'segments';
      buffer.addEventListener('updateend', () => { busy = false; pump(); });
      buffer.addEventListener('error', () => fail(new Error('the decoder rejected a fragment')));
      appendInit();
    } catch (err) { fail(err); }
  }, { once: true });

  async function appendInit() {
    try {
      busy = true;
      buffer.appendBuffer(initSegment(track));
    } catch (err) { fail(err); }
  }

  /**
   * Append the next window, if one is wanted.
   *
   * Driven by where the playhead is rather than by a timer: a book left paused fetches
   * nothing, and a seek to hour eleven throws away the queue and starts there.
   */
  async function pump() {
    if (closed || busy || !buffer || media.readyState !== 'open') return;
    const at = audio?.currentTime || 0;
    const bufferedTo = bufferedEnd(at);
    if (bufferedTo - at > AHEAD_SECONDS) return;
    if (appendedTo >= track.count) {
      try { if (media.readyState === 'open') media.endOfStream(); } catch { /* already ended */ }
      return;
    }
    const w = windowAt(track, Math.max(at, timeOfSample(appendedTo)), WINDOW_SECONDS);
    if (!w) { appendedTo = track.count; return; }
    busy = true;
    try {
      const bytes = await read(w.start, w.end);
      if (closed || !bytes?.length) { busy = false; return; }
      const seg = mediaSegment(track, w.from, w.to, bytes, w.start, w.from + 1);
      if (!seg.length) { busy = false; appendedTo = track.count; return; }
      appendedTo = Math.max(appendedTo, w.to);
      buffer.appendBuffer(seg);   // `updateend` clears busy and calls back in
    } catch (err) {
      busy = false;
      fail(err);
    }
  }

  function timeOfSample(index) {
    let t = 0;
    for (let i = 0; i < index && i < track.count; i++) t += track.deltas[i];
    return t / track.timescale;
  }

  function bufferedEnd(at) {
    if (!buffer) return 0;
    for (let i = 0; i < buffer.buffered.length; i++) {
      if (buffer.buffered.start(i) <= at + 0.1 && buffer.buffered.end(i) >= at) return buffer.buffered.end(i);
    }
    return at;
  }

  return {
    url,
    /** Watch an element so the feeder knows where playback actually is. */
    attach(el) {
      audio = el;
      el.addEventListener('timeupdate', pump);
      el.addEventListener('seeking', () => {
        // A seek past what is buffered means the queued window is the wrong one.
        appendedTo = 0;
        pump();
      });
      el.addEventListener('waiting', pump);
    },
    dispose() {
      closed = true;
      try { if (media.readyState === 'open') media.endOfStream(); } catch { /* fine */ }
      URL.revokeObjectURL(url);
    },
  };
}
