// The opener: a book on screen, in the dock, and on the lock screen.
//
// Runs in its own sandboxed frame on an opaque origin — no cookies, no `Authorization`
// header, no same-origin fetch. Everything arrives over the port the host transferred in.
//
// Three things are worth reading the order of, because they are the reason this is a plugin
// rather than an `<audio>` tag:
//
//   1. STRUCTURE BEFORE AUDIO. `openBook` reads the head and tail of a several-hundred-
//      megabyte file to find its chapter list, and does not touch the audio at all. That is
//      what the ranged reader in the SDK exists for.
//   2. THE DOCK IS WHY IT KEEPS PLAYING. A docked frame's iframe is created once and never
//      re-parented — moving an <iframe> reloads its document, which would stop the book
//      mid-sentence — so the host floats it as a fixed overlay tracking a box instead.
//      Enabling the dock is what lets someone browse the drive while the book plays.
//   3. THE MEDIA SESSION IS THE OS. Lock screen, media keys, notification shade, car
//      stereo. Handlers are registered once and released when the frame goes.

import { activate } from 'trove';
import { openBook, releaseBook, loadCover } from './book.js';
import { Transport, chapterAt, clock } from './transport.js';
import { canStream, streamUrl } from './stream.js';

const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
};
const kids = (node, list) => { for (const k of list) if (k) node.appendChild(k); return node; };

activate(async (ctx) => {
  ctx.onOpen(async (file) => {
    injectStyle();
    document.body.innerHTML = '';
    const root = el('div', 'ab');
    document.body.appendChild(root);
    // A SPINNER and a phase, because this can be slow and used to be a single unchanging
    // line. "Reading the book's structure…" sat there for minutes on a 500 MB book with
    // nothing to say whether it was working, and no way to tell slow from hung.
    const status = el('div', 'ab-status');
    const say = (text) => { status.innerHTML = ''; status.append(el('span', 'ab-spin'), el('span', null, text)); };
    say('Opening…');
    root.appendChild(status);

    // Both settings up front. `settings.get` crosses the port, so reading one inside a
    // click handler would put a round trip between the tap and the seek.
    const [skipRaw, keep] = await Promise.all([
      ctx.settings.get('audiobook.skipSeconds').catch(() => null),
      ctx.settings.get('audiobook.keepOffline').catch(() => false),
    ]);
    const skip = Number(skipRaw) > 0 ? Number(skipRaw) : 30;

    let book;
    try {
      book = await openBook(ctx, file);
      // The cover, resolved once here rather than in two render paths. It costs one
      // ranged read of bytes already described by the index — no audio is touched.
      // Two forms of the same picture: an object URL for the <img> in this frame, and a
      // data: URL for the media session, which the HOST sets and which cannot load this
      // frame's opaque-origin blobs. See loadCover.
      const art = await loadCover(ctx, file, book.cover);
      book.coverUrl = art?.url || null;
      book.coverArtwork = art?.artwork || null;
    } catch (err) {
      root.innerHTML = '';
      root.appendChild(el('div', 'ab-error', err?.message || 'This book could not be opened.'));
      return;
    }

    // A single-file book streams from a MINTED url: the browser issues its own range
    // requests, so seeking is free and nothing is buffered ahead of what is played. An LPF
    // already holds object URLs over its own entries — see book.js.
    // WHERE THE AUDIO COMES FROM, and why it is not a URL.
    //
    // This frame's CSP is `connect-src 'none'` and `media-src blob: data:`, on purpose:
    // a viewer must not be able to reach the network, so it cannot be an exfiltration
    // side-channel. `<audio src="https://…/api/items/download?id=…">` is therefore
    // BLOCKED — which is exactly what shipped, and what "pressing play does nothing"
    // was. The console said so all along, inside a frame nothing could read.
    //
    // A Blob is allowed. So a book that is already downloaded plays from its own bytes,
    // and one that is not offers to fetch them rather than pretending it can stream.
    // THREE WAYS TO GET AUDIO, in the order that costs the listener least.
    //
    //   1. STREAM. The book is transmuxed to fragmented MP4 on the fly and fed to a
    //      MediaSource — audio starts after a few hundred kilobytes, seeking to hour
    //      eleven reads hour eleven, and nothing is stored. See stream.js.
    //   2. A LOCAL BLOB, if the book was downloaded. No transmuxing, no network.
    //   3. DOWNLOAD, when neither works — a codec MediaSource will not take, or a
    //      container whose tables this cannot read. A download button is a worse
    //      experience than streaming and a far better one than a play button that
    //      silently does nothing, which is what shipped.
    //
    // None of them is a URL. The frame's CSP forbids that, deliberately.
    let src = null;
    let stream = null;
    if (!book.tracks) {
      // The sample tables, which only streaming needs. For an indexed book they have not
      // been read yet — see `loadTables` — and reading them is the expensive part, so it
      // is announced.
      let moov = book.moov;
      let moovError = book.moovError;
      if (!moov && book.tables) {
        say('Reading the book’s index…');
        const got = await book.tables((size) => say(`Reading the book’s index (${Math.round(size / 1048576)} MB)…`));
        moov = got.moov;
        moovError = got.error;
      }

      const streamable = canStream(moov, moovError);
      if (streamable.track) {
        // A million-sample table has already been walked by `canStream`, on this thread.
        // Yield once so the spinner it was drawn behind actually paints before the next
        // stretch of work — otherwise the frame is frozen and looks hung rather than busy.
        say('Preparing playback…');
        await new Promise((r) => setTimeout(r, 0));
        const blob = await ctx.files.blob(file.id).catch(() => null);
        if (blob) {
          stream = streamUrl(streamable, async (start, end) => blob.slice(start, end).bytes(), {
            onError: (err) => console.error('[audiobook] stream failed:', err?.message || err),
          });
          src = stream.url;
        }
      }
      if (!src) {
        const local = await ctx.files.localBlob(file.id).catch(() => null);
        if (local) src = URL.createObjectURL(local);
      }
      if (!src) {
        // Draw the book anyway — cover, title and chapters all came from the index — with
        // a download in place of the transport, and the reason streaming was not on offer.
        renderOffline(ctx, root, book, file, skip, streamable.why);
        return;
      }
    }

    // "Keep it while I listen", if the setting says so. This is what turns every range the
    // browser fetches into bytes worth keeping, so a book listened straight through
    // downloads itself exactly once — and a book nobody asked to keep leaves nothing
    // behind. See the SDK's `files.offline`.
    if (keep) ctx.files.offline.start(file.id).catch(() => {});

    render(ctx, root, book, src, skip, file, stream);
  });
});

/**
 * The book, with a download where the transport would be.
 *
 * Not an error state: everything on screen — cover, title, narrator, chapter list — came
 * from the index without reading a byte of audio, so there is a real book here. What is
 * missing is the audio, and the honest thing is to say so and offer to get it, rather
 * than draw a play button that cannot work.
 */
function renderOffline(ctx, root, book, file, skip, why) {
  root.innerHTML = '';
  const status = el('div', 'ab-note', why
    ? `Can\u2019t stream this one — ${why}. Download it to listen.`
    : 'This book is not on this device yet.');
  const bar = el('div', 'ab-dl');
  const fill = el('div', 'ab-dl-fill');
  bar.appendChild(fill);
  const get = el('button', 'ab-btn ab-get', 'Download to play');
  get.title = 'Fetch this book so it can be played here';

  let polling = null;
  const stop = () => { if (polling) clearInterval(polling); polling = null; };
  const paint = (s) => {
    fill.style.width = `${Math.round((s.ratio || 0) * 100)}%`;
    if (s.local) {
      stop();
      status.textContent = 'Ready — reopening…';
      // Reopen through the ordinary path now that the bytes are here, so there is exactly
      // one place that knows how to build a player.
      ctx.files.localBlob(file.id).then((blob) => {
        if (blob) render(ctx, root, book, URL.createObjectURL(blob), skip, file);
      }).catch(() => {});
    } else if (s.filling) {
      status.textContent = s.total
        ? `Downloading… ${Math.round((s.ratio || 0) * 100)}%`
        : 'Downloading…';
    }
  };

  get.addEventListener('click', () => {
    get.disabled = true;
    status.textContent = 'Downloading…';
    ctx.files.offline.start(file.id).catch(() => {});
    // Polled rather than pushed: `offline.status` is the only signal the SDK offers, and
    // a two-second tick is cheap next to the transfer it is watching.
    polling = setInterval(() => ctx.files.hasLocal(file.id).then(paint).catch(() => {}), 2000);
  });

  kids(root, [
    coverOf(book),
    el('div', 'ab-title', book.title),
    byline(book),
    status,
    bar,
    get,
    book.chapters.length > 1 ? chapterList(book) : null,
  ]);

  // Already downloading from a previous visit? Then show that, not an offer to start.
  ctx.files.hasLocal(file.id).then((s) => {
    if (!s.filling && !s.local) return;
    get.disabled = true;
    polling = setInterval(() => ctx.files.hasLocal(file.id).then(paint).catch(() => {}), 2000);
    paint(s);
  }).catch(() => {});

  ctx.onDeactivate(stop);
}

/** The cover, drawn from the range the indexer recorded. */
function coverOf(book) {
  if (!book.coverUrl) return null;
  const img = el('img', 'ab-cover');
  img.src = book.coverUrl;
  img.alt = '';
  return img;
}

/** "Author · read by Narrator", with whichever halves exist. */
function byline(book) {
  const parts = [book.author, book.narrator && `read by ${book.narrator}`].filter(Boolean);
  return parts.length ? el('div', 'ab-author', parts.join(' · ')) : null;
}

/** The chapter list as a read-only rundown, for the state with no transport to drive. */
function chapterList(book) {
  return chapterRows(book, null);
}

/**
 * The chapters, as rows.
 *
 * A LIST rather than a `<select>`, which is what Storia does and the reason is the
 * content: an audiobook has sixty-odd chapters with real titles and start times, and a
 * select shows exactly one of them at a time. A list is scannable, says where you are,
 * and lets someone jump without first opening a menu to see what the options were.
 *
 * `onSeek` null makes it a rundown rather than a control — the offline state has a book
 * to describe and no transport to drive.
 */
function chapterRows(book, onSeek) {
  const list = el('ul', 'tracks');
  for (const [i, c] of book.chapters.entries()) {
    const row = el('li', 'chapter');
    row.dataset.index = String(i);
    const go = el('button', 'chapter-play', '▶');
    go.title = `Play “${c.title}”`;
    if (onSeek) go.addEventListener('click', () => onSeek(c.time));
    else go.disabled = true;
    kids(row, [
      go,
      el('span', 'track-num', String(i + 1)),
      el('span', 'chapter-title', c.title),
      el('span', 'chapter-time', clock(c.time)),
    ]);
    list.appendChild(row);
  }
  return list;
}

function render(ctx, root, book, src, skip, file, stream) {
  root.innerHTML = '';

  // This item's data, for THIS plugin — the position and the speed. Declared here rather
  // than where it is first read because the rate buttons are built before the resume, and
  // a `const` used above its declaration is a dead-zone error rather than a hoist.
  const store = ctx.files.data(file.id);

  // The stage is Storia's, class for class — see `src/client/player/player.css` in
  // 3sln/storia. Same names on purpose: this viewer and that app are the same product
  // seen from two directions, and a change to one should be legible against the other.
  const chapterLine = el('h2', 'np-chapter', '');
  const sub = el('div', 'np-sub muted', '');
  const timeNow = el('span', 'time', '0:00');
  const timeLeft = el('span', 'time', '0:00');
  const bar = el('input', 'seek-bar');
  bar.type = 'range';
  bar.min = '0';
  bar.step = '1';
  bar.value = '0';

  const transport = new Transport({
    onTime: (at) => paint(at),
    onState: (state) => {
      play.textContent = state === 'playing' ? '⏸' : '▶';
      play.title = state === 'playing' ? 'Pause' : 'Play';
      ctx.media.setPlaybackState(state).catch(() => {});
    },
    onEnd: () => ctx.media.setPlaybackState('paused').catch(() => {}),
  });

  const button = (label, hint, fn, className = 'ab-btn') => {
    const b = el('button', className, label);
    b.title = hint;
    b.addEventListener('click', fn);
    return b;
  };
  const jump = (delta) => {
    // `+1` so that "previous" from two seconds into a chapter goes to the previous one
    // rather than restarting this one — which is what every other player does, and what
    // someone who missed a sentence means by pressing it.
    const { index } = chapterAt(book.chapters, transport.position() + 1);
    const to = book.chapters[Math.max(0, Math.min(book.chapters.length - 1, index + delta))];
    if (to) transport.seek(to.time);
  };
  const play = button('▶', 'Play', () => transport.toggle(), 'play-big');

  // A skip button carries its own number, the way Storia's does: two buttons that differ
  // only by direction are hard to tell apart at a glance, and the interval is the thing
  // someone is actually choosing between.
  const skipBtn = (glyph, hint, fn) => {
    const b = el('button', 'icon-btn skip-btn');
    b.title = hint;
    b.appendChild(el('span', 'skip-glyph', glyph));
    b.appendChild(el('span', 'skip-num', String(skip)));
    b.addEventListener('click', fn);
    return b;
  };

  // Speeds as PILLS rather than a <select>. Playback rate is the control an audiobook
  // listener touches most, and a select hides the current value behind a click.
  const rates = el('div', 'rates');
  const paintRates = () => {
    for (const b of rates.children) b.classList.toggle('active', Number(b.dataset.rate) === transport.rate);
  };
  for (const r of [1, 1.25, 1.5, 1.75, 2]) {
    const b = el('button', 'rate', `${r}×`);
    b.dataset.rate = String(r);
    b.addEventListener('click', () => {
      transport.rate = r;
      paintRates();
      // Speed is a per-book preference, not a global one: people listen to a dense
      // non-fiction title slower than a novel they already know.
      store.set('rate', r).catch(() => {});
      // The OS draws its own progress from the rate as well as the position, so a book at
      // 1.5× drifts visibly on the lock screen unless this is re-reported.
      paint(transport.position());
    });
    rates.appendChild(b);
  }

  const cover = coverOf(book);
  const list = chapterRows(book, (time) => transport.seek(time));

  kids(root, [
    kids(el('div', 'np-hero'), [
      cover ? kids(el('div', 'np-cover'), [cover]) : null,
      kids(el('div', 'np-controls'), [
        kids(el('div', 'np-meta'), [
          el('h1', 'np-book-title', book.title),
          byline(book),
          book.series ? el('div', 'np-series muted', book.series) : null,
        ]),
        chapterLine,
        sub,
        kids(el('div', 'np-scrub'), [timeNow, bar, timeLeft]),
        kids(el('div', 'transport'), [
          button('⏮', 'Previous chapter', () => jump(-1), 'icon-btn'),
          skipBtn('↺', `Back ${skip} seconds`, () => transport.seek(transport.position() - skip)),
          play,
          skipBtn('↻', `Forward ${skip} seconds`, () => transport.seek(transport.position() + skip)),
          button('⏭', 'Next chapter', () => jump(1), 'icon-btn'),
        ]),
        rates,
      ]),
    ]),
    book.chapters.length > 1 ? list : null,
    book.why ? el('div', 'ab-note', book.why) : null,
  ]);
  paintRates();

  // WHERE THE LISTENER LEFT OFF.
  //
  // Stored against the item rather than in a setting, so it follows someone to their
  // phone — which is the whole reason `files.data` exists. Read before the transport
  // opens so the first seek is the resume rather than a jump the listener sees.
  let saved = 0;
  store.all().then((d) => {
    const at = Number(d?.position) || 0;
    // Ignore a position at the very end: a book finished last week should start again,
    // not open two seconds from the end with nothing left to play.
    const total = transport.duration();
    if (at > 5 && (!total || at < total - 15)) transport.seek(at);
    if (Number(d?.rate) > 0) { transport.rate = Number(d.rate); paintRates(); }
  }).catch(() => {});

  // Saved TWO WAYS, and it needs both.
  //
  // On the events that mean "the listener stopped" — pause, seek, the tab going away —
  // because those are exact: a book closed mid-sentence remembers the sentence, where a
  // timer alone would round it back to the last tick.
  //
  // And on a timer WHILE PLAYING, because those events only cover a graceful stop. A tab
  // that crashes, a browser the OS kills for memory, a laptop that loses power, a phone
  // evicting a background tab — none of them fire `pagehide`, and an audiobook is exactly
  // the thing people leave running for hours. Without the timer, that is hours re-listened.
  //
  // The interval is the floor on how much can be lost, not how often anything is written:
  // the 1-second delta guard below and the SDK's own coalescing mean a paused book writes
  // nothing at all, and a playing one writes a few bytes locally and one small request.
  // Every twenty seconds OF BOOK, not of wall clock — see `paint`, which is where the
  // periodic save is driven from.
  const SAVE_EVERY_SECONDS = 20;
  const remember = () => {
    const at = transport.position();
    if (!Number.isFinite(at) || Math.abs(at - saved) < 1) return;
    saved = at;
    store.set('position', Math.floor(at)).catch(() => {});
  };

  transport.audio.addEventListener('pause', remember);
  transport.audio.addEventListener('ended', remember);
  // `seeked`, not the seek handlers: a lock-screen scrub and a drag of the bar both end
  // here, and so does a chapter jump. One place, whoever asked.
  transport.audio.addEventListener('seeked', remember);
  // `pagehide` rather than `unload`, which does not fire reliably when a tab is discarded.
  addEventListener('pagehide', remember);
  document.addEventListener('visibilitychange', () => { if (document.hidden) remember(); });

  transport.open(book, src);
  // The feeder needs the element to know where the playhead is: it appends ahead of
  // playback and re-queues on a seek, so a paused book fetches nothing.
  stream?.attach(transport.audio);

  // Dragging the bar must not be fought by the tick that redraws it.
  let scrubbing = false;
  bar.addEventListener('input', () => { scrubbing = true; labels(Number(bar.value)); });
  bar.addEventListener('change', () => { scrubbing = false; transport.seek(Number(bar.value)); });

  function paint(at) {
    const total = transport.duration();
    if (total) bar.max = String(Math.floor(total));
    if (!scrubbing) bar.value = String(Math.floor(at));
    labels(at);
    // THE PERIODIC SAVE, driven by the MEDIA CLOCK rather than a timer.
    //
    // `paint` runs from `timeupdate`, which fires because playback advanced. That matters
    // for the case this exists to cover: someone listening with the tab in the background
    // or the screen off, driving it from the lock screen. A hidden tab has its timers
    // throttled — Chrome exempts audible tabs, but that is a policy to rely on rather than
    // a guarantee, and it is not uniform across browsers. `timeupdate` keeps arriving for
    // as long as audio is actually moving, which is exactly when there is progress worth
    // recording, and stops on its own when it is not.
    //
    // The event saves above still handle a graceful stop precisely; this bounds what an
    // ungraceful one can lose — a crashed tab, an OOM kill, a flat battery — to twenty
    // seconds of book rather than to the whole session.
    if (Math.abs(at - saved) >= SAVE_EVERY_SECONDS) remember();
    // Position AND rate: the OS draws its own progress from these, and without the rate a
    // book played at 1.5× drifts visibly out of step on the lock screen.
    ctx.media.setPositionState({ duration: total || 0, position: at, playbackRate: transport.rate })
      .catch(() => {});
  }

  function labels(at) {
    const total = transport.duration();
    const { index, chapter } = chapterAt(book.chapters, at);
    chapterLine.textContent = chapter ? chapter.title : '';
    sub.textContent = index >= 0
      ? `Chapter ${index + 1} of ${book.chapters.length}`
      : `${book.chapters.length} chapter${book.chapters.length === 1 ? '' : 's'}`;
    timeNow.textContent = clock(at);
    // Remaining rather than total on the right: "how much longer" is the question, and
    // the bar already implies the length.
    timeLeft.textContent = total ? `-${clock(Math.max(0, total - at))}` : '0:00';
    for (const row of list.children) {
      row.classList.toggle('active', Number(row.dataset.index) === index);
    }
  }

  wireOs(ctx, transport, book, skip, jump, src, stream);
}

/** The OS transport controls, the dock, and giving both back on the way out. */
async function wireOs(ctx, transport, book, skip, jump, src, stream) {
  ctx.media.setMetadata({
    title: book.title,
    artist: book.author || '',
    album: book.series || (book.chapters.length > 1 ? `${book.chapters.length} chapters` : ''),
    // The lock screen draws this. It is the same object URL the panel shows, so the OS
    // and the app agree about what the book looks like.
    artwork: book.coverArtwork ? [{ src: book.coverArtwork }] : undefined,
  }).catch(() => {});

  const handlers = {
    play: () => transport.play(),
    pause: () => transport.pause(),
    seekbackward: () => transport.seek(transport.position() - skip),
    seekforward: () => transport.seek(transport.position() + skip),
    previoustrack: () => jump(-1),
    nexttrack: () => jump(1),
    // `seekto` is what a lock-screen scrubber sends, and it is the one that makes the OS
    // controls a real player rather than a pause button.
    seekto: (details) => transport.seek(details?.seekTime ?? transport.position()),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    ctx.media.setActionHandler(action, fn).catch(() => {});
  }

  // Docked, so the book survives navigating away. The frame is never re-parented — the
  // host floats it over a target box — which is precisely why this works at all.
  // Tall enough for the whole docked strip — cover, title, chapter line and the
  // transport row — because 96px was not: the controls fell below the fold and a docked
  // book could only be paused by scrolling a picture-in-picture window first, which is
  // the one thing the dock exists to make easy. Measured against the docked rules in
  // `injectStyle`: a 64px cover plus a 44px play button plus padding does not fit in
  // less than about 180.
  ctx.dock.enable({ minSize: { width: 340, height: 190 } }).catch(() => {});
  ctx.dock.onChange((state) => { document.body.dataset.docked = state?.docked ? 'yes' : 'no'; });

  ctx.onDeactivate(() => {
    transport.destroy();
    // The cover's object URL, and the audio's. Both are this frame's, and nothing else
    // can free them — the audio one is the whole book held in memory.
    if (book.coverUrl?.startsWith('blob:')) URL.revokeObjectURL(book.coverUrl);
    if (stream) stream.dispose();
    else if (src?.startsWith('blob:')) URL.revokeObjectURL(src);
    // The object URLs an LPF minted over its own entries. Nothing else can free them, and
    // they are the whole book in memory.
    releaseBook(book);
  });
}

/**
 * The frame's own stylesheet.
 *
 * Inline because a sandboxed frame on an opaque origin cannot fetch its own package files —
 * everything it has arrives over the port, and one string beats a resource round trip
 * before the first paint.
 */
function injectStyle() {
  if (document.getElementById('ab-style')) return;
  const s = document.createElement('style');
  s.id = 'ab-style';
  s.textContent = `
    /* Storia's tokens and stage, transplanted. The frame is on an opaque origin with its
       own document, so nothing here can be shared with the host or with that app — the
       values are copied, and the class names are kept identical so the two are legible
       against each other. See 3sln/storia: src/worker/routes/pages.js (tokens) and
       src/client/player/player.css (stage). */
    :root {
      color-scheme: dark;
      --bg: #12121a;
      --accent: #5b3df5;
      --accent-soft: color-mix(in srgb, var(--accent) 22%, transparent);
      --accent-contrast: #fff;
      --fg: #ece9f3;
      --muted: color-mix(in srgb, var(--fg) 68%, transparent);
      --surface-1: color-mix(in srgb, var(--fg) 5%, transparent);
      --surface-2: color-mix(in srgb, var(--fg) 8%, transparent);
      --surface-3: color-mix(in srgb, var(--fg) 12%, transparent);
      --hairline: color-mix(in srgb, var(--fg) 12%, transparent);
      --shadow-3: 0 20px 60px rgba(0,0,0,.5);
      --ease: cubic-bezier(.22,.61,.36,1);
    }
    * { box-sizing: border-box; }
    body { margin: 0; font: 15px/1.45 system-ui, -apple-system, sans-serif; color: var(--fg);
           background: transparent; }
    .muted { color: var(--muted); }

    /* The stage. The accent wash behind the cover is Storia's .player-app background —
       and note the absence of backticks in this comment: the whole stylesheet is a
       template literal, so one here ends it and turns the next CSS selector into
       JavaScript. It did, and the viewer failed with "app is not defined".
       it is what stops a dark panel reading as an empty one. */
    .ab {
      min-height: 100%;
      display: flex; flex-direction: column; align-items: center;
      gap: clamp(10px, 2.2vh, 22px);
      padding: clamp(14px, 3vh, 26px) clamp(16px, 5vw, 34px);
      background:
        radial-gradient(120% 80% at 50% -10%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 60%),
        var(--bg);
    }
    .np-hero { display: flex; flex-direction: column; align-items: center;
               gap: clamp(10px, 2.2vh, 22px); text-align: center;
               width: 100%; max-width: 600px; }
    .np-cover { line-height: 0; }
    .np-cover .ab-cover { width: min(74vw, 38vh, 340px); height: auto; aspect-ratio: 1;
      border-radius: clamp(16px, 2.4vw, 24px); object-fit: cover;
      box-shadow: var(--shadow-3); background: var(--surface-2); }
    .np-controls { display: flex; flex-direction: column; align-items: stretch;
                   gap: clamp(10px, 2.2vh, 22px); width: 100%; min-width: 0; }
    .np-meta { display: flex; flex-direction: column; gap: 2px; align-items: center; }
    .np-book-title { font-size: clamp(1.15rem, 3.6vw, 1.55rem); font-weight: 700; margin: 0;
      line-height: 1.18; max-width: 20ch;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .ab-author { font-size: 0.88rem; margin: 0; color: var(--muted); }
    .np-series { font-size: 0.78rem; }
    .np-chapter { font-size: 0.98rem; font-weight: 550; color: var(--accent); margin: 6px 0 0;
      line-height: 1.25; max-width: 30ch;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .np-sub { font-size: 0.78rem; margin: 0; }

    .np-scrub { display: flex; align-items: center; gap: 12px; width: 100%; max-width: 460px;
                margin: 0 auto; }
    .np-scrub .time { font-variant-numeric: tabular-nums; font-size: 0.77rem; color: var(--muted);
                      min-width: 48px; text-align: center; }
    .seek-bar { flex: 1; accent-color: var(--accent); height: 6px; cursor: pointer; }

    .transport { display: flex; align-items: center; justify-content: center; gap: clamp(6px, 3vw, 20px); }
    .icon-btn { background: none; border: none; color: var(--fg); cursor: pointer;
      display: grid; place-items: center; width: 40px; height: 40px; border-radius: 10px;
      font-size: 22px; transition: background .12s, color .12s, transform .06s; }
    .icon-btn:hover { background: var(--surface-2); }
    .icon-btn:active { transform: scale(.94); }
    .skip-btn { position: relative; font-size: 27px; }
    .skip-btn .skip-glyph { font-size: 27px; line-height: 1; }
    /* The interval sits INSIDE the glyph, which is the only thing that tells two
       otherwise-identical arrows apart at a glance. */
    .skip-num { position: absolute; inset: 0; display: grid; place-items: center;
      font-size: 0.55rem; font-weight: 700; padding-top: 1px; font-variant-numeric: tabular-nums; }
    .play-big { width: clamp(64px, 16vw, 76px); height: clamp(64px, 16vw, 76px); border-radius: 50%;
      border: none; background: var(--accent); color: var(--accent-contrast);
      display: grid; place-items: center; cursor: pointer; font-size: 30px;
      box-shadow: 0 12px 30px color-mix(in srgb, var(--accent) 55%, transparent);
      transition: transform .12s var(--ease); }
    .play-big:hover { transform: scale(1.05); }
    .play-big:active { transform: scale(.96); }

    .rates { display: flex; gap: 4px; justify-content: center; }
    .rate { background: none; border: 1px solid transparent; color: var(--muted);
      font-size: 0.8rem; font-weight: 600; padding: 5px 11px; border-radius: 999px;
      cursor: pointer; transition: color .12s, background .12s; }
    .rate:hover { color: var(--fg); }
    .rate.active { color: var(--accent-contrast); background: var(--accent); }

    /* Chapters, beneath the stage. A list rather than a select — see chapterRows. */
    .tracks { list-style: none; margin: 0; padding: 0; width: 100%; max-width: 600px;
      display: flex; flex-direction: column; gap: 1px; }
    .chapter { display: flex; align-items: center; gap: 10px; padding: 6px 10px;
      border-radius: 9px; }
    .chapter:hover { background: var(--surface-1); }
    .chapter.active { background: color-mix(in srgb, var(--accent) 14%, transparent); }
    .chapter-play { width: 28px; height: 28px; border-radius: 50%; border: 1px solid var(--hairline);
      background: none; color: var(--fg); display: grid; place-items: center; cursor: pointer;
      font-size: 11px; flex: none; }
    .chapter-play:disabled { opacity: .3; cursor: default; }
    .chapter.active .chapter-play { background: var(--accent); color: var(--accent-contrast);
      border-color: transparent; }
    .track-num { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 0.8rem;
      min-width: 1.8em; text-align: right; }
    .chapter-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 0.92rem; text-align: left; }
    .chapter-time { color: var(--muted); font-size: 0.78rem; font-variant-numeric: tabular-nums; }

    .ab-note { color: var(--muted); font-size: 12px; max-width: 600px; }
    .ab-error { color: #fb7185; padding: 12px; }
    .ab-status { color: var(--muted); padding: 12px; display: flex; align-items: center; gap: 10px; }
    /* A spinner, because the work behind this message can take a while and a line of
       static text cannot tell slow from hung. */
    .ab-spin { width: 14px; height: 14px; flex: none; border-radius: 50%;
      border: 2px solid var(--surface-3); border-top-color: var(--accent);
      animation: ab-spin 0.8s linear infinite; }
    @keyframes ab-spin { to { transform: rotate(360deg); } }

    /* The download state, when a book cannot be streamed here. */
    .ab-dl { height: 4px; border-radius: 2px; background: var(--surface-2); overflow: hidden;
      width: 100%; max-width: 460px; }
    .ab-dl-fill { height: 100%; width: 0; background: var(--accent); transition: width .3s; }
    .ab-get { background: var(--accent); color: var(--accent-contrast); border: 0;
      border-radius: 11px; padding: 10px 15px; font: inherit; font-weight: 550; cursor: pointer; }

    /* DOCKED: the frame is a strip a few hundred pixels wide, so the stage turns on its
       side — cover as a thumbnail, controls beside it. The chapter list and the note do
       not fit and are not what someone glancing at a docked player wants. */
    body[data-docked="yes"] .tracks,
    body[data-docked="yes"] .ab-note,
    body[data-docked="yes"] .np-sub,
    body[data-docked="yes"] .np-series,
    body[data-docked="yes"] .rates { display: none; }
    body[data-docked="yes"] .ab { padding: 10px 12px; gap: 8px; }
    body[data-docked="yes"] .np-hero { flex-direction: row; align-items: center;
      text-align: left; gap: 12px; }
    body[data-docked="yes"] .np-cover .ab-cover { width: 64px; border-radius: 10px; }
    body[data-docked="yes"] .np-meta { align-items: flex-start; }
    body[data-docked="yes"] .np-book-title { font-size: 0.95rem; -webkit-line-clamp: 1; }
    body[data-docked="yes"] .np-chapter { font-size: 0.82rem; margin: 0; -webkit-line-clamp: 1; }
    body[data-docked="yes"] .play-big { width: 44px; height: 44px; font-size: 20px; }
    body[data-docked="yes"] .icon-btn { width: 32px; height: 32px; font-size: 18px; }
    body[data-docked="yes"] .transport { gap: 4px; justify-content: flex-start; }

    /* Short viewports: the cover is the first thing that can go — the chapter, the
       scrubber and the transport all matter more than a picture. */
    @media (max-height: 560px) {
      .np-hero { gap: 10px; }
      .np-book-title { font-size: 1.05rem; }
      .play-big { width: 56px; height: 56px; }
    }
    @media (max-height: 430px) { .np-cover { display: none; } }
  `;
  document.head.appendChild(s);
}
