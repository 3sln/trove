// The "speak to search" surface, and the part of it that works with no API at all.
//
// Two jobs, and they are independent on purpose:
//
//   1. PUT THE SEARCH FIELD UNDER THE MICROPHONE. A TV remote's mic dictates into
//      whatever text field the platform keyboard is attached to, and does nothing at
//      all when there isn't one. So the command opens the search surface and focuses
//      its input. On webOS and Tizen that is the entire feature — the platform does
//      the listening, the text arrives as ordinary input events, and Trove never asks
//      for a microphone.
//
//   2. TRANSCRIBE OURSELVES, where the browser can do it on-device (see voice.js).
//      Additive: if it isn't available the field is still focused and the remote's own
//      mic still works.

import { cell } from '../runtime.js';
import { canTranscribeLocally, localAvailability, installLocal, listen } from './voice.js';

export class VoiceSearchService {
  /**
   * @param {object} deps
   * @param {object} deps.notifications
   */
  constructor({ notifications, settings } = {}) {
    this.notifications = notifications;
    this.settings = settings;
    this.session = null;
    this.state = { supported: canTranscribeLocally(), status: 'unknown', listening: false };
    this.cell = cell(this.state);
  }

  observe() {
    return this.cell;
  }
  #set(patch) {
    this.state = { ...this.state, ...patch };
    this.cell.setValue(this.state);
  }

  /** Ask once whether an on-device language pack is ready, and remember the answer. */
  async refresh() {
    if (!this.state.supported) return 'unavailable';
    const status = await localAvailability(this.#lang());
    this.#set({ status });
    return status;
  }

  #lang() {
    return this.settings?.get?.('search.voiceLanguage') || navigator.language || 'en-US';
  }

  /** Can we offer a microphone button right now? */
  canListen() {
    return this.state.supported && (this.state.status === 'available' || this.state.status === 'downloadable');
  }

  /**
   * The command behind `search.voice`.
   *
   * `focus` is what makes this worth binding on a TV even when we cannot transcribe:
   * it is the difference between the remote's mic having a target and being swallowed
   * by the platform assistant.
   */
  async run({ onText } = {}) {
    this.openSearchSurface();
    // Focus AFTER the surface has rendered — the input does not exist yet on the frame
    // that opened it.
    await this.focusInput();
    if (!this.state.supported) return { listening: false, reason: 'unsupported' };

    const status = this.state.status === 'unknown' ? await this.refresh() : this.state.status;
    if (status === 'downloadable') {
      // Pressing the button IS the consent to fetch it; nothing downloads before that.
      this.notifications?.info('Downloading the on-device voice model — this happens once.');
      const ok = await installLocal(this.#lang());
      this.#set({ status: ok ? 'available' : 'unavailable' });
      if (!ok) return { listening: false, reason: 'install-failed' };
    } else if (status !== 'available') {
      return { listening: false, reason: status };
    }
    return this.toggle({ onText });
  }

  /** Start listening, or stop if already. */
  toggle({ onText } = {}) {
    if (this.session) {
      this.stop();
      return { listening: false };
    }
    try {
      this.session = listen({
        lang: this.#lang(),
        onText,
        onEnd: () => { this.session = null; this.#set({ listening: false }); },
        onError: (err) => {
          this.session = null;
          this.#set({ listening: false });
          // A refused microphone is a decision, not a fault worth shouting about.
          if (!/not-allowed|service-not-allowed|denied/i.test(err.message)) {
            this.notifications?.warn(`Couldn't listen: ${err.message}`);
          }
        },
      });
      this.#set({ listening: true });
      return { listening: true };
    } catch (err) {
      this.notifications?.warn(`Couldn't listen: ${err.message}`);
      return { listening: false, reason: 'error' };
    }
  }

  stop() {
    this.session?.stop();
    this.session = null;
    this.#set({ listening: false });
  }

  /**
   * Make sure a search field is on screen.
   *
   * Already on the launcher with nothing open → it is the search surface, use it. Any
   * other view, or a file open over it → the modal, which is the one search box that
   * can appear over anything.
   */
  openSearchSurface() {
    const wb = this.workbench;
    if (!wb) return;
    const onLauncher = wb.state.activity === 'home' && !wb.nav?.state?.activeTabId;
    if (onLauncher) wb.closeSearchModal?.();
    else wb.openSearchModal();
  }

  /** @returns {Promise<boolean>} whether an input actually took focus */
  focusInput({ tries = 12 } = {}) {
    return new Promise((resolve) => {
      let left = tries;
      const attempt = () => {
        const el = document.querySelector('.search-modal .launch-input') || document.querySelector('.launch-input');
        if (el) {
          el.focus();
          // Put the caret at the end so dictation appends rather than overwriting a
          // query someone already typed.
          try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* not a text input */ }
          resolve(document.activeElement === el);
          return;
        }
        if (--left <= 0) { resolve(false); return; }
        requestAnimationFrame(attempt);
      };
      attempt();
    });
  }
}
