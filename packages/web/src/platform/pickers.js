// The two things only the browser can do: ask for a file, and save one.
//
// These are effects, so they are reached from actions rather than from a render — but they
// are effects on the DOCUMENT rather than on the drive, which is why they live in
// `platform` and not in `bl`. An action that needs a file from the user calls in here; the
// action is still the thing that decides what happens to it.
//
// They were private to bl/commands.js, where the command handlers that used them lived.

/**
 * Open a native file picker. Resolves with the chosen files, or `null` if cancelled.
 *
 * A PROMISE rather than a callback, because the action that opens the picker has to be able
 * to wait for it. It could not before: `execute` returned while the OS dialog was still on
 * screen, ngin released the leases in its `finally`, the feed emitted `complete` for an
 * upload that had not begun, and the callback then used `engine` and `explorer` afterwards.
 *
 * SETTLING ON BOTH PATHS is the whole difficulty, and the reason this shape was not taken
 * earlier: cancelling fires no `change` event at all. It is detected the only way the
 * platform allows — the OS dialog returns focus to the window, and after a short grace the
 * input still holds no files. Both paths go through `done`, and `resolve` is idempotent, so
 * whichever happens first settles the promise and the other is a no-op. A picker that could
 * fail to settle would hold its action's lease forever and never emit a terminal event,
 * which is strictly worse than the early `complete` this replaces.
 *
 * The hidden `<input>` is removed on both paths too, so a cancelled picker does not leak
 * one per attempt.
 */
function pick(configure) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    configure(input);
    input.style.display = 'none';
    document.body.appendChild(input);
    const done = (files) => {
      resolve(files);
      input.remove();
      window.removeEventListener('focus', onFocus);
    };
    const onFocus = () => setTimeout(() => { if (!input.files.length) done(null); }, 300);
    input.addEventListener('change', () => done(input.files), { once: true });
    window.addEventListener('focus', onFocus);
    input.click();
  });
}

/** @returns {Promise<FileList|null>} */
export function pickFiles() {
  return pick((input) => { input.multiple = true; });
}

/** @returns {Promise<File|null>} */
export function pickZip() {
  return pick((input) => { input.accept = '.zip,application/zip'; }).then((files) => files?.[0] ?? null);
}

/** Hand a URL to the browser as a download. */
export function triggerDownload(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name || '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
