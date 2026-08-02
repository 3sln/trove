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
import { openBook, releaseBook } from './book.js';
import { Transport, chapterAt, clock } from './transport.js';

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
    } catch (err) {
      root.innerHTML = '';
      root.appendChild(el('div', 'ab-error', err?.message || 'This book could not be opened.'));
      return;
    }

    // A single-file book streams from a MINTED url: the browser issues its own range
    // requests, so seeking is free and nothing is buffered ahead of what is played. An LPF
    // already holds object URLs over its own entries — see book.js.
    let src = null;
    if (!book.tracks) {
      try {
        src = (await ctx.files.mediaUrl(file.id)).url;
        // Which URL the frame was handed, and whether it is same-origin with this
        // document. It never is — the frame runs on an OPAQUE origin — and saying so
        // here is what makes the media error below legible instead of mysterious.
        console.info('[audiobook] media url:', { url: String(src).slice(0, 120), frameOrigin: String(location.origin) });
      } catch (err) {
        root.innerHTML = '';
        root.appendChild(el('div', 'ab-error', `This book cannot be played: ${err.message}`));
        return;
      }
    }

    // "Keep it while I listen", if the setting says so. This is what turns every range the
    // browser fetches into bytes worth keeping, so a book listened straight through
    // downloads itself exactly once — and a book nobody asked to keep leaves nothing
    // behind. See the SDK's `files.offline`.
    if (keep) ctx.files.offline.start(file.id).catch(() => {});

    render(ctx, root, book, src, skip);
  });
});

function render(ctx, root, book, src, skip) {
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

  kids(root, [
    el('div', 'ab-title', book.title),
    book.author || book.narrator
      ? el('div', 'ab-author', [book.author, book.narrator && `read by ${book.narrator}`].filter(Boolean).join(' · '))
      : null,
    chapterLine,
    bar,
    times,
    kids(el('div', 'ab-controls'), [
      button('⏮', 'Previous chapter', () => jump(-1)),
      button('↺', `Back ${skip}s`, () => transport.seek(transport.position() - skip)),
      play,
      button('↻', `Forward ${skip}s`, () => transport.seek(transport.position() + skip)),
      button('⏭', 'Next chapter', () => jump(1)),
    ]),
    book.chapters.length > 1 ? chapters : null,
    book.why ? el('div', 'ab-note', book.why) : null,
  ]);

  transport.open(book, src);

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

  wireOs(ctx, transport, book, skip, jump);
}

/** The OS transport controls, the dock, and giving both back on the way out. */
async function wireOs(ctx, transport, book, skip, jump) {
  ctx.media.setMetadata({
    title: book.title,
    artist: book.author || '',
    album: book.chapters.length > 1 ? `${book.chapters.length} chapters` : '',
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
    .ab { display: grid; gap: 6px; padding: 12px 14px; background: rgba(20,21,25,.92); border-radius: 10px; }
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
  `;
  document.head.appendChild(s);
}
