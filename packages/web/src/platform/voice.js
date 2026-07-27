// Dictating into the search box.
//
// THE REMOTE'S MIC BUTTON IS NOT OURS. On every TV platform it belongs to the system:
// webOS's SDK exposes no way for an app to listen to the Magic Remote, Tizen's voice
// control is a packaged-app API that does not exist for a page in the TV browser, and
// on Android TV the button raises Assistant. No key event reaches the document, so
// there is nothing to intercept and no shortcut to bind.
//
// What the button DOES do is dictate into a focused text field, through the platform's
// own keyboard. That is the whole opportunity: the mic is useful exactly when there is
// somewhere for its text to land. `search.voice` therefore does not try to capture a
// button — it makes sure the search field is open and focused, so the mic on the remote
// has a target. That half works on every TV, with no API at all.
//
// This module is the OTHER half, for browsers that can transcribe themselves (Chrome,
// so Android TV and the desktop). It is deliberately narrow:
//
//   ON-DEVICE ONLY. By default `SpeechRecognition` streams audio to the browser
//   vendor's servers. Trove is a drive you host so that your files stay yours, and
//   shipping a microphone that quietly forwards your voice to a third party would
//   contradict the entire point of it. `processLocally` asks for recognition that never
//   leaves the machine; a browser that cannot promise that is simply reported as
//   unsupported, and the button is never offered.

/**
 * Resolved per call, not captured at import.
 *
 * A module-level constant would freeze the answer at load time, which is wrong twice
 * over: the page may gain the API later (a polyfill, a flag flipped behind a restart),
 * and a test could never stand in for it. Reading it when asked costs a property lookup.
 */
function impl() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/**
 * Whether this browser can transcribe WITHOUT sending audio anywhere.
 *
 * `available()` is the on-device half of the API; a browser that lacks it has no notion
 * of local recognition, which for us is the same as having no recognition. Detecting
 * the constructor alone would be the bug: every Chrome has that, and most of them would
 * happily record you into a datacentre.
 */
export function canTranscribeLocally() {
  const Impl = impl();
  return !!Impl && typeof Impl.available === 'function';
}

const optionsFor = (lang) => ({ langs: [lang], processLocally: true });

/**
 * `'available' | 'downloadable' | 'downloading' | 'unavailable'`
 *
 * A language pack that is merely `downloadable` is not usable yet, and downloading one
 * unasked would spend someone's bandwidth on a button they have not pressed.
 */
export async function localAvailability(lang = navigator.language || 'en-US') {
  if (!canTranscribeLocally()) return 'unavailable';
  try {
    return await impl().available(optionsFor(lang));
  } catch {
    return 'unavailable';
  }
}

/** Fetch the on-device language pack. Only ever called from an explicit user action. */
export async function installLocal(lang = navigator.language || 'en-US') {
  if (typeof impl()?.install !== 'function') return false;
  try {
    return await impl().install(optionsFor(lang));
  } catch {
    return false;
  }
}

/**
 * Listen, and report what was heard.
 *
 * `onText(text, { final })` fires for interim results too, so the query updates as
 * someone speaks rather than landing in one lump at the end — on a TV that feedback is
 * the difference between "it is listening" and "did it hear me".
 *
 * @returns {{stop: () => void}}
 */
export function listen({ lang = navigator.language || 'en-US', onText, onEnd, onError } = {}) {
  if (!canTranscribeLocally()) throw new Error('On-device speech recognition is not available here');
  const rec = new (impl())();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = false;
  // Both spellings: `options` is the shape the explainer settled on, and shipping
  // builds also read the flag straight off the instance. Setting one the browser
  // ignores is harmless; setting neither would mean asking for local processing and
  // silently getting the remote kind.
  rec.options = optionsFor(lang);
  rec.processLocally = true;

  let stopped = false;
  rec.onresult = (event) => {
    let text = '';
    let final = false;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      text += event.results[i][0].transcript;
      if (event.results[i].isFinal) final = true;
    }
    onText?.(text.trim(), { final });
  };
  // `no-speech` and `aborted` are what happens when someone changes their mind. They
  // are not failures worth a toast.
  rec.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    onError?.(new Error(event.error || 'Speech recognition failed'));
  };
  rec.onend = () => { if (!stopped) { stopped = true; onEnd?.(); } };

  try {
    rec.start();
  } catch (err) {
    stopped = true;
    onError?.(err);
    onEnd?.();
  }

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try { rec.stop(); } catch { /* already finished */ }
      onEnd?.();
    },
  };
}
