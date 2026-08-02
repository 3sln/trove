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
    root.appendChild(el('div', 'ab-status', 'Reading the book’s structure…'));

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
      book.coverUrl = await loadCover(ctx, file, book.cover);
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
      const streamable = book.moov ? canStream(book.moov) : null;
      if (streamable) {
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
        // a download in place of the transport.
        renderOffline(ctx, root, book, file, skip);
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
function renderOffline(ctx, root, book, file, skip) {
  root.innerHTML = '';
  const status = el('div', 'ab-note', 'This book is not on this device yet.');
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
  const sel = el('select', 'ab-chapters');
  for (const [i, c] of book.chapters.entries()) {
    sel.appendChild(el('option', null, `${i + 1}. ${c.title}`));
  }
  sel.disabled = true;
  return sel;
}

function render(ctx, root, book, src, skip, file, stream) {
  root.innerHTML = '';

  const chapterLine = el('div', 'ab-chapter', '');
  const times = el('div', 'ab-times', '');
  const bar = el('input', 'ab-seek');
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
  const play = button('▶', 'Play', () => transport.toggle(), 'ab-btn ab-play');

  const chapters = el('select', 'ab-chapters');
  for (const [i, c] of book.chapters.entries()) {
    const o = el('option', null, `${i + 1}. ${c.title}`);
    o.value = String(c.time);
    chapters.appendChild(o);
  }
  chapters.addEventListener('change', () => transport.seek(Number(chapters.value)));

  // Playback rate. A primary control for an audiobook rather than a nicety — most people
  // who listen to books do not listen at 1× — and the transport and media session already
  // carry it, so the only thing missing was somewhere to press.
  const rate = el('select', 'ab-rate');
  for (const r of [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
    const o = el('option', null, `${r}×`);
    o.value = String(r);
    if (r === 1) o.selected = true;
    rate.appendChild(o);
  }
  rate.title = 'Playback speed';
  rate.addEventListener('change', () => {
    transport.rate = Number(rate.value);
    // The OS draws its own progress from the rate as well as the position, so a book at
    // 1.5× drifts visibly on the lock screen unless this is re-reported.
    paint(transport.position());
  });

  kids(root, [
    kids(el('div', 'ab-head'), [
      coverOf(book),
      kids(el('div', 'ab-headings'), [
        el('div', 'ab-title', book.title),
        byline(book),
        book.series ? el('div', 'ab-series', book.series) : null,
      ]),
    ]),
    chapterLine,
    bar,
    times,
    kids(el('div', 'ab-controls'), [
      button('⏮', 'Previous chapter', () => jump(-1)),
      button('↺', `Back ${skip}s`, () => transport.seek(transport.position() - skip)),
      play,
      button('↻', `Forward ${skip}s`, () => transport.seek(transport.position() + skip)),
      button('⏭', 'Next chapter', () => jump(1)),
      rate,
    ]),
    book.chapters.length > 1 ? chapters : null,
    book.why ? el('div', 'ab-note', book.why) : null,
  ]);

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
    // Position AND rate: the OS draws its own progress from these, and without the rate a
    // book played at 1.5× drifts visibly out of step on the lock screen.
    ctx.media.setPositionState({ duration: total || 0, position: at, playbackRate: transport.rate })
      .catch(() => {});
  }

  function labels(at) {
    const total = transport.duration();
    const { index, chapter } = chapterAt(book.chapters, at);
    chapterLine.textContent = chapter ? chapter.title : '';
    if (chapters.selectedIndex !== index) chapters.selectedIndex = index;
    times.textContent = total ? `${clock(at)} · ${clock(total - at)} left` : clock(at);
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
    artwork: book.coverUrl ? [{ src: book.coverUrl }] : undefined,
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
  ctx.dock.enable({ minSize: { width: 300, height: 96 } }).catch(() => {});
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
    :root { color-scheme: dark; }
    body { margin: 0; font: 13px/1.4 system-ui, sans-serif; color: #e8e8ea; background: transparent; }
    /* The panel is as tall as the pane it is given, so the card centres in it rather than
       clinging to the top edge with a field of black beneath — which is what the docked
       styling did when it was asked to fill a viewer. Docked, the max-width and the
       centring both stop mattering because the frame is only a few hundred pixels wide. */
    .ab { display: grid; gap: 8px; align-content: start; padding: 16px;
          background: rgba(20,21,25,.92); border-radius: 10px;
          max-width: 560px; margin: 0 auto; }
    .ab-head { display: flex; gap: 12px; align-items: flex-start; }
    .ab-headings { display: grid; gap: 2px; min-width: 0; }
    .ab-cover { width: 88px; height: 88px; object-fit: cover; border-radius: 6px;
                background: #2a2c34; flex: none; }
    .ab-series { color: #8f929c; font-size: 11px; }
    .ab-rate { background: #2a2c34; color: inherit; border: 0; border-radius: 6px;
               padding: 6px; font-size: 12px; cursor: pointer; }
    .ab-get { justify-self: start; }
    .ab-dl { height: 4px; border-radius: 2px; background: #2a2c34; overflow: hidden; }
    .ab-dl-fill { height: 100%; width: 0; background: #6ea8fe; transition: width .3s; }
    .ab-title { font-weight: 600; font-size: 14px; }
    .ab-author, .ab-times, .ab-note { color: #a2a4ad; font-size: 12px; }
    .ab-chapter { font-size: 12px; }
    .ab-seek { width: 100%; accent-color: #6ea8fe; }
    .ab-controls { display: flex; gap: 6px; align-items: center; justify-content: center; }
    .ab-btn { background: #2a2c34; color: inherit; border: 0; border-radius: 6px;
              padding: 6px 10px; font-size: 14px; cursor: pointer; }
    .ab-btn:hover { background: #353845; }
    .ab-play { font-size: 16px; padding: 6px 14px; }
    .ab-chapters { background: #2a2c34; color: inherit; border: 0; border-radius: 6px; padding: 5px; }
    .ab-error { color: #ff9a9a; padding: 12px; }
    .ab-status { color: #a2a4ad; padding: 12px; }
    /* Docked, the frame is a strip in the corner: the chapter list and the note do not fit
       and are not what someone glancing at it wants. */
    body[data-docked="yes"] .ab-chapters,
    body[data-docked="yes"] .ab-note { display: none; }
    /* Docked, the card is the whole strip and the cover shrinks to a thumbnail. */
    body[data-docked="yes"] .ab { max-width: none; padding: 10px 12px; gap: 6px; }
    body[data-docked="yes"] .ab-cover { width: 40px; height: 40px; }
    body[data-docked="yes"] .ab-series { display: none; }
  `;
  document.head.appendChild(s);
}
