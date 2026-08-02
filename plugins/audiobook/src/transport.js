// Playback, as one timeline.
//
// A book is one duration and one position however many files it is made of. That is the
// whole job of this module: an M4B is a single `<audio>` and its position IS the book's,
// while an LPF is a track list and the book's position is "everything before this track,
// plus where we are inside it". Every caller above works in book seconds and never learns
// which of the two it is holding.
//
// One `<audio>` element for the whole session, reused across tracks. Creating a new one per
// track loses the user's volume and playback rate, and on iOS costs the gesture that
// allowed playback in the first place — a fresh element has not been touched, so it cannot
// start until the user taps again.

export class Transport {
  /**
   * @param {{onTime: Function, onState: Function, onEnd: Function}} hooks
   */
  constructor({ onTime, onState, onEnd } = {}) {
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.book = null;
    this.trackIndex = 0;
    this.onTime = onTime || (() => {});
    this.onState = onState || (() => {});
    this.onEnd = onEnd || (() => {});

    // DIAGNOSTIC. The frame is sandboxed on an opaque origin, so nothing outside it can
    // see why a load failed — the host page cannot reach this element, and a silent
    // failure here looks exactly like "the play button does nothing", which is how this
    // shipped. Every terminal media state says so out loud, prefixed so it is greppable
    // in a console that also carries the host's logs.
    //
    // Remove this only once the media path no longer depends on the frame fetching a URL
    // of its own — see the remote-blob/MediaSource work.
    const MEDIA_ERR = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
    const NETWORK_STATE = ['EMPTY', 'IDLE', 'LOADING', 'NO_SOURCE'];
    this.audio.addEventListener('error', () => {
      const code = this.audio.error?.code;
      console.error('[audiobook] media load failed:', {
        code,
        why: MEDIA_ERR[code] || 'unknown',
        message: this.audio.error?.message || null,
        networkState: NETWORK_STATE[this.audio.networkState] ?? this.audio.networkState,
        readyState: this.audio.readyState,
        // The src is the whole question: an opaque-origin document sends no credentials,
        // so a drive behind an authenticating proxy answers this differently than it
        // answers the host.
        src: String(this.audio.currentSrc || this.audio.src || '').slice(0, 120),
      });
    });
    this.audio.addEventListener('stalled', () => console.warn('[audiobook] media stalled'));
    this.audio.addEventListener('loadedmetadata', () => {
      console.info('[audiobook] media ready:', { duration: this.audio.duration });
    });

    this.audio.addEventListener('timeupdate', () => this.onTime(this.position()));
    this.audio.addEventListener('durationchange', () => this.onTime(this.position()));
    this.audio.addEventListener('play', () => this.onState('playing'));
    this.audio.addEventListener('pause', () => this.onState('paused'));
    // A track ending is the next track starting, except for the last one. Doing this here
    // rather than in the UI is what makes an LPF play through unattended.
    this.audio.addEventListener('ended', () => {
      if (this.book?.tracks && this.trackIndex < this.book.tracks.length - 1) {
        this.#load(this.trackIndex + 1, 0, true);
      } else {
        this.onState('paused');
        this.onEnd();
      }
    });
  }

  /**
   * @param {object} book from book.js
   * @param {string|null} src the media URL for a single-file book; null for a track list
   */
  open(book, src) {
    this.book = book;
    this.src = src;
    this.trackIndex = 0;
    if (src) this.audio.src = src;
    else this.#load(0, 0, false);
  }

  /** The book's total length, from the container or by adding the tracks up. */
  duration() {
    if (this.book?.duration) return this.book.duration;
    if (this.book?.tracks) {
      return this.book.tracks.every((t) => t.duration)
        ? this.book.tracks.reduce((n, t) => n + t.duration, 0)
        : null;
    }
    return Number.isFinite(this.audio.duration) ? this.audio.duration : null;
  }

  /** Where we are, in BOOK seconds. */
  position() {
    const inTrack = Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0;
    return this.#trackStart(this.trackIndex) + inTrack;
  }

  /** Seek to a book second, changing tracks if that is what it means. */
  seek(seconds) {
    const at = Math.max(0, seconds);
    if (!this.book?.tracks) {
      this.audio.currentTime = at;
      return;
    }
    const index = this.#trackAt(at);
    const offset = at - this.#trackStart(index);
    if (index === this.trackIndex) this.audio.currentTime = offset;
    else this.#load(index, offset, !this.audio.paused);
  }

  play() { return this.audio.play(); }
  pause() { this.audio.pause(); }
  toggle() { return this.audio.paused ? this.play() : (this.pause(), Promise.resolve()); }
  get playing() { return !this.audio.paused; }
  set rate(v) { this.audio.playbackRate = v; }
  get rate() { return this.audio.playbackRate; }

  /** Stop, release the element, and let the page reclaim whatever it was buffering. */
  destroy() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  #trackStart(index) {
    if (!this.book?.tracks) return 0;
    let at = 0;
    for (let i = 0; i < index; i++) at += this.book.tracks[i].duration || 0;
    return at;
  }

  #trackAt(seconds) {
    if (!this.book?.tracks) return 0;
    let at = 0;
    for (let i = 0; i < this.book.tracks.length; i++) {
      const end = at + (this.book.tracks[i].duration || 0);
      if (seconds < end) return i;
      at = end;
    }
    return this.book.tracks.length - 1;
  }

  /**
   * Point the element at a track and, once it can, seek and resume.
   *
   * `loadedmetadata` rather than a timer: setting `currentTime` before the element knows
   * the track's duration is silently ignored by every browser, which is how a chapter jump
   * comes to start the chapter from the beginning.
   */
  #load(index, offset, resume) {
    const track = this.book.tracks[index];
    this.trackIndex = index;
    this.audio.src = track.url;
    const ready = () => {
      this.audio.removeEventListener('loadedmetadata', ready);
      if (offset) this.audio.currentTime = offset;
      if (resume) this.audio.play().catch(() => {});
      this.onTime(this.position());
    };
    this.audio.addEventListener('loadedmetadata', ready);
  }
}

/** The chapter containing `seconds`, and its index. */
export function chapterAt(chapters, seconds) {
  let index = 0;
  for (let i = 0; i < chapters.length; i++) if (chapters[i].time <= seconds) index = i;
  return { index, chapter: chapters[index] || null };
}

/** `1:02:03`, or `2:03` for anything under an hour. */
export function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}
