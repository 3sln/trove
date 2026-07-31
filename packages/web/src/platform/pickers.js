// The two things only the browser can do: ask for a file, and save one.
//
// These are effects, so they are reached from actions rather than from a render — but they
// are effects on the DOCUMENT rather than on the drive, which is why they live in
// `platform` and not in `bl`. An action that needs a file from the user calls in here; the
// action is still the thing that decides what happens to it.
//
// They were private to bl/commands.js, where the command handlers that used them lived.

/**
 * Open a native file picker.
 *
 * The hidden `<input>` is removed on selection AND on cancel — cancelling fires no
 * `change`, so cleanup also hangs off the next window focus (which the OS dialog returns)
 * to avoid leaking a growing pile of inputs.
 */
function pick(cb, configure) {
  const input = document.createElement('input');
  input.type = 'file';
  configure(input);
  input.style.display = 'none';
  document.body.appendChild(input);
  const cleanup = () => { input.remove(); window.removeEventListener('focus', onFocus); };
  const onFocus = () => setTimeout(() => { if (!input.files.length) cleanup(); }, 300);
  input.addEventListener('change', () => { cb(input.files); cleanup(); }, { once: true });
  window.addEventListener('focus', onFocus);
  input.click();
}

export function pickFiles(cb) {
  pick((files) => cb(files), (input) => { input.multiple = true; });
}

export function pickZip(cb) {
  pick((files) => cb(files[0]), (input) => { input.accept = '.zip,application/zip'; });
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
