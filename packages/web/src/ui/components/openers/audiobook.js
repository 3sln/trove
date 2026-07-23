// Audiobook opener — plays m4b/m4a/mp3 with chapter navigation, rich metadata,
// cover art, variable speed, ±30s skip, and resumable progress. Chapters and
// metadata are parsed straight from the MP4 boxes (see ../../mp4.js) via Range
// reads, so opening a huge audiobook is instant. Playback position is persisted
// per file (localStorage), so closing and reopening resumes exactly where you
// left off. Seeking works because the download endpoint serves byte ranges.
//
// The <audio> element is created imperatively and kept in a per-file controller
// so playback survives re-renders; the view is a pure function of controller
// state rendered through bones `watch`.

import { dd, ObservableSubject } from '../../../runtime.js';
import { icon } from '../../icon.js';
import { duration } from '../../format.js';
import { readAudiobookInfo } from '../../mp4.js';

const { div, img, span, button, input } = dd;

const controllers = new Map(); // fileId -> Controller
const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

class Controller {
  constructor(node, ui) {
    this.node = node;
    this.ui = ui;
    this.url = ui.platform.api.downloadUrl(node.id);
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.audio.src = this.url;
    this.state$ = new ObservableSubject({
      loading: true, playing: false, current: 0, total: 0, rate: this.#savedRate(),
      chapters: [], meta: {}, coverUrl: null, error: null, buffered: 0,
    });
    this.state = this.state$.value;
    this.audio.playbackRate = this.state.rate;
    this.#wireAudio();
    this.#load();
  }

  #set(patch) {
    this.state = { ...this.state, ...patch };
    this.state$.next(this.state);
  }

  #wireAudio() {
    const a = this.audio;
    a.addEventListener('loadedmetadata', () => {
      this.#set({ total: a.duration });
      const saved = this.#savedPosition();
      if (saved > 0 && saved < a.duration - 5) a.currentTime = saved;
    });
    a.addEventListener('timeupdate', () => {
      this.#set({ current: a.currentTime });
      this.#persist();
    });
    a.addEventListener('progress', () => {
      try {
        if (a.buffered.length) this.#set({ buffered: a.buffered.end(a.buffered.length - 1) });
      } catch { /* ignore */ }
    });
    a.addEventListener('play', () => this.#set({ playing: true }));
    a.addEventListener('pause', () => this.#set({ playing: false }));
    a.addEventListener('ended', () => this.#set({ playing: false }));
    a.addEventListener('error', () => this.#set({ error: 'Could not play this file', loading: false }));
  }

  async #load() {
    try {
      const info = await readAudiobookInfo(this.url, { fetch: (u, o) => fetch(u, o) });
      let coverUrl = null;
      if (info.cover) coverUrl = URL.createObjectURL(new Blob([info.cover.bytes], { type: info.cover.mime }));
      this.coverUrl = coverUrl;
      this.#set({
        loading: false,
        chapters: info.chapters || [],
        meta: {
          title: info.title || this.node.name.replace(/\.[^.]+$/, ''),
          author: info.author || info.albumArtist || '',
          narrator: info.narrator || '',
          album: info.album || '',
        },
        coverUrl,
      });
    } catch (err) {
      this.#set({ loading: false, error: null, meta: { title: this.node.name } });
    }
  }

  #key() {
    return `trove.audiobook.${this.node.id}`;
  }
  #savedPosition() {
    try {
      return JSON.parse(localStorage.getItem(this.#key()))?.position || 0;
    } catch {
      return 0;
    }
  }
  #savedRate() {
    try {
      return JSON.parse(localStorage.getItem(this.#key()))?.rate || 1;
    } catch {
      return 1;
    }
  }
  #persist() {
    try {
      localStorage.setItem(this.#key(), JSON.stringify({ position: this.audio.currentTime, rate: this.state.rate, updatedAt: Date.now() }));
    } catch { /* ignore */ }
  }

  toggle() {
    if (this.audio.paused) {
      for (const c of controllers.values()) if (c !== this) c.audio.pause();
      this.audio.play().catch(() => this.#set({ error: 'Playback was blocked — click play again.' }));
    } else this.audio.pause();
  }
  seek(t) {
    this.audio.currentTime = Math.max(0, Math.min(t, this.state.total || t));
  }
  skip(delta) {
    this.seek(this.audio.currentTime + delta);
  }
  setRate(r) {
    this.audio.playbackRate = r;
    this.#set({ rate: r });
    this.#persist();
  }
  cycleRate() {
    const i = RATES.indexOf(this.state.rate);
    this.setRate(RATES[(i + 1) % RATES.length]);
  }
  currentChapterIndex() {
    const { chapters, current } = this.state;
    let idx = -1;
    for (let i = 0; i < chapters.length; i++) if (chapters[i].start <= current + 0.25) idx = i;
    return idx;
  }
  gotoChapter(i) {
    const ch = this.state.chapters[i];
    if (ch) {
      this.seek(ch.start);
      if (this.audio.paused) this.toggle();
    }
  }
  nextChapter() {
    const i = this.currentChapterIndex();
    if (i + 1 < this.state.chapters.length) this.gotoChapter(i + 1);
    else this.skip(30);
  }
  prevChapter() {
    const i = this.currentChapterIndex();
    // If >3s into a chapter, restart it; else go to previous.
    const ch = this.state.chapters[i];
    if (ch && this.state.current - ch.start > 3) this.seek(ch.start);
    else if (i > 0) this.gotoChapter(i - 1);
    else this.skip(-30);
  }
}

export function audiobookOpener(node, ui) {
  let ctrl = controllers.get(node.id);
  if (!ctrl) {
    ctrl = new Controller(node, ui);
    controllers.set(node.id, ctrl);
  }
  const { watch } = ui.platform.reactive;
  return dd.alias(() => watch(ctrl.state$, (s) => render(s, ctrl, ui)))();
}

function render(s, ctrl, ui) {
  if (s.loading) {
    return div({ className: 'viewer' }, div({ className: 'loading' }, div({ className: 'spinner' }), span('Reading audiobook…')));
  }
  const curCh = ctrl.currentChapterIndex();
  return div({ className: 'audiobook' },
    coverPane(s, ctrl, curCh),
    chaptersPane(s, ctrl, curCh),
  );
}

function coverPane(s, ctrl, curCh) {
  const m = s.meta;
  return div({ className: 'cover-pane' },
    s.coverUrl
      ? img({ className: 'cover', src: s.coverUrl, alt: '' })
      : div({ className: 'cover' }, icon('book', { size: 64 })),
    div({ className: 'meta' },
      div({ className: 'title' }, m.title || 'Untitled'),
      m.author ? div({ className: 'author' }, m.author) : null,
      m.narrator ? div({ className: 'narrator' }, 'Narrated by ' + m.narrator) : null,
      s.chapters.length ? div({ className: 'narrator' }, `${s.chapters.length} chapters`) : null,
    ),
    s.error ? div({ $styling: { color: 'var(--danger)', fontSize: '12px' } }, s.error) : null,
    transport(s, ctrl, curCh),
  );
}

function transport(s, ctrl, curCh) {
  const chapter = s.chapters[curCh];
  return div({ className: 'transport' },
    chapter ? div({ $styling: { textAlign: 'center', fontSize: '12px', color: 'var(--text-dim)' } }, chapter.title) : null,
    div({ className: 'scrub' },
      span({ className: 'time' }, duration(s.current)),
      input({
        type: 'range', min: 0, max: Math.max(1, Math.floor(s.total || 0)), value: Math.floor(s.current),
        $attrs: { step: 1 },
      }).on({ input: (e) => ctrl.seek(Number(e.target.value)) }),
      span({ className: 'time' }, duration(s.total)),
    ),
    div({ className: 'buttons' },
      button({ className: 'skip', title: 'Previous chapter' }, icon('skip-back', { size: 18 })).on({ click: () => ctrl.prevChapter() }),
      button({ className: 'skip', title: 'Back 30s' }, icon('back-30', { size: 20 })).on({ click: () => ctrl.skip(-30) }),
      button({ className: 'play', title: s.playing ? 'Pause' : 'Play' }, icon(s.playing ? 'pause' : 'play', { size: 24 })).on({ click: () => ctrl.toggle() }),
      button({ className: 'skip', title: 'Forward 30s' }, icon('fwd-30', { size: 20 })).on({ click: () => ctrl.skip(30) }),
      button({ className: 'skip', title: 'Next chapter' }, icon('skip-forward', { size: 18 })).on({ click: () => ctrl.nextChapter() }),
    ),
    div({ $styling: { display: 'flex', justifyContent: 'center' } },
      button({ className: 'rate', title: 'Playback speed' }, `${s.rate}×`).on({ click: () => ctrl.cycleRate() }),
    ),
  );
}

function chaptersPane(s, ctrl, curCh) {
  if (!s.chapters.length) {
    return div({ className: 'chapters' },
      div({ className: 'empty' }, icon('book', { size: 28 }), span('No chapter markers in this file.')));
  }
  return div({ className: 'chapters' },
    div({ className: 'ch-head' }, span('Chapters'), span({ className: 'count' }, `${s.chapters.length}`)),
    ...s.chapters.map((ch, i) => {
      const next = s.chapters[i + 1];
      const len = (next ? next.start : s.total) - ch.start;
      return div({ className: `chapter ${i === curCh ? 'current' : ''}` },
        span({ className: 'n' }, String(i + 1)),
        span({ className: 't' }, ch.title || `Chapter ${i + 1}`),
        span({ className: 'd' }, duration(len)),
      ).on({ click: () => ctrl.gotoChapter(i) });
    }),
  );
}
