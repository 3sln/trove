// Keeping a media element pointed at a URL that still works.
//
// A minted URL expires (docs/design/signed-urls.md). Content URLs are long — longer than
// almost any sitting — but "almost" is not "always": someone pauses a film, closes the
// laptop, and comes back tomorrow. So the element has to be able to swap its own source,
// and swapping the source under a playing video is not a matter of assigning `src`.
//
// Both refresh paths are needed and neither is sufficient alone:
//
//   PROACTIVE  a timer from `expiresAt`. Handles the common case invisibly.
//   REACTIVE   the element's own `error`. A backgrounded tab has its timers throttled,
//              so the proactive refresh may simply never run — which is exactly the
//              paused-overnight case, the one the timer was supposed to cover.

const REFRESH_AT = 0.8; // of the URL's life, so the swap lands well before it matters.
const MAX_TIMER = 2 ** 31 - 1; // setTimeout overflows past this and fires immediately.

/**
 * Point `el` at `node`'s bytes and keep it pointed there.
 *
 * @param {HTMLMediaElement|HTMLImageElement} el
 * @param {object} node
 * @param {object} ui
 * @param {{op?: string, onError?: (msg: string) => void}} [opts]
 * @returns {() => void} detach
 */
export function attachMedia(el, node, ui, { op = 'media', onError } = {}) {
  const urls = ui.platform.mediaUrls;
  let timer = null;
  let stopped = false;
  // One retry per URL. A file whose bytes are genuinely gone would otherwise re-mint
  // forever, hammering the server over a 404 that is never going to change.
  let retried = false;

  const clear = () => { clearTimeout(timer); timer = null; };

  const schedule = (expiresAt) => {
    clear();
    if (!Number.isFinite(expiresAt)) return; // nothing was minted; nothing expires
    const wait = Math.max(1000, (expiresAt - Date.now()) * REFRESH_AT);
    timer = setTimeout(() => apply({ resume: true }), Math.min(wait, MAX_TIMER));
  };

  /**
   * Fetch a URL and put it on the element, preserving where the user was.
   *
   * The order matters and every step earns its place: without `resume` the film restarts
   * from the beginning, without `load()` an element that has already errored may not pick
   * up the new source at all, and without the final `play()` it sits there paused looking
   * like a crash.
   */
  async function apply({ resume }) {
    if (stopped) return;
    const media = isMedia(el);
    const at = media && resume ? el.currentTime : 0;
    const wasPlaying = media && resume ? !el.paused && !el.ended : false;
    let got;
    try {
      got = await urls.url(node.id, { op });
    } catch (err) {
      if (!stopped) onError?.(err.message);
      return;
    }
    if (stopped) return;
    el.src = got.url;
    if (media) {
      el.load();
      if (at > 0 || wasPlaying) {
        const restore = () => {
          el.removeEventListener('loadedmetadata', restore);
          // Guard the seek: a live or zero-length source has nowhere to seek to, and
          // assigning currentTime there throws.
          if (at > 0 && Number.isFinite(el.duration) && el.duration > at) el.currentTime = at;
          if (wasPlaying) el.play().catch(() => { /* autoplay policy; the user can press play */ });
        };
        el.addEventListener('loadedmetadata', restore);
      }
    }
    schedule(got.expiresAt);
  }

  // The retry budget is spent by a failed LOAD and refunded by a successful one — not by
  // a successful mint. Refunding it in `apply` meant a file whose bytes are genuinely
  // gone re-minted forever: every retry got a perfectly good URL, reset the budget, and
  // failed again, so the fallback was never shown and the request never stopped.
  const onLoaded = () => { retried = false; };
  el.addEventListener('load', onLoaded);      // <img>
  el.addEventListener('loadeddata', onLoaded); // <audio>/<video>

  // The reactive half. An expired URL and a missing file look identical from here — both
  // are just a failed load — so it re-mints once and, if that fails too, says so.
  const onElementError = () => {
    if (stopped) return;
    if (retried) { onError?.(null); return; }
    retried = true;
    urls.invalidate(node.id, op);
    apply({ resume: true });
  };
  el.addEventListener('error', onElementError);

  apply({ resume: false });

  return () => {
    stopped = true;
    clear();
    el.removeEventListener('error', onElementError);
    el.removeEventListener('load', onLoaded);
    el.removeEventListener('loadeddata', onLoaded);
  };
}

function isMedia(el) {
  return typeof el?.play === 'function' && typeof el?.load === 'function';
}
