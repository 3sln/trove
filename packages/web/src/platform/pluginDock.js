// FrameDock — where a plugin frame's iframe is *shown*, and the floating dock (PiP).
//
// A frame's iframe is created once and stays a child of <body> for its life — we
// NEVER re-parent it, because moving an <iframe> in the DOM reloads its document (per
// the HTML spec) and would kill the running plugin + its MessagePort. To show a frame
// "inside" a panel/viewer/dock we float it as a position:fixed overlay whose inset
// tracks the target element's box (`place`), recomputed on intersection/resize/scroll
// rather than every animation frame — the viewer area only moves on layout changes,
// so this stays idle when nothing shifts.
//
// The dock is the single floating mini-player a viewer becomes when you navigate away
// (video → PiP, audio → mini transport), if the viewer opted in via `dock.enable`.

export class FrameDock {
  /**
   * @param {object} deps
   * @param {(frame:object)=>void} deps.destroyFrame  tear a frame down for good
   * @param {(node:object, openerId:string)=>void} deps.openFile  reopen the docked file
   * @param {()=>void} [deps.onChange]  notify listeners (the dock affects plugin state)
   */
  constructor({ destroyFrame, openFile, onChange } = {}) {
    this.destroyFrame = destroyFrame;
    this.openFile = openFile;
    this.onChange = onChange || (() => {});
    this.docked = null; // the frame currently in the dock
    this.el = null; // the dock's DOM host (created lazily)
  }

  // --- placement -------------------------------------------------------------

  /** Float `frame`'s iframe over `targetEl` and keep its inset aligned. */
  place(frame, targetEl, z, radius = '') {
    this.stopPlace(frame);
    const f = frame.iframe;
    f.style.cssText = `position:fixed;border:0;visibility:visible;display:block;background:transparent;z-index:${z};margin:0;padding:0;border-radius:${radius};`;
    const sync = () => {
      const r = targetEl.getBoundingClientRect();
      const shown = r.width > 0 && r.height > 0 && document.contains(targetEl);
      f.style.left = `${r.left}px`;
      f.style.top = `${r.top}px`;
      f.style.width = `${r.width}px`;
      f.style.height = `${r.height}px`;
      f.style.visibility = shown ? 'visible' : 'hidden';
    };
    sync();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(targetEl);
    if (document.body) ro?.observe(document.body);
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(sync, { threshold: [0, 1] }) : null;
    io?.observe(targetEl);
    window.addEventListener('scroll', sync, true);
    window.addEventListener('resize', sync);
    frame.place = {
      target: targetEl,
      stop: () => {
        ro?.disconnect();
        io?.disconnect();
        window.removeEventListener('scroll', sync, true);
        window.removeEventListener('resize', sync);
      },
    };
  }

  stopPlace(frame) {
    if (frame.place) { frame.place.stop(); frame.place = null; }
  }

  /** Stop tracking and park the iframe offscreen (kept alive, just not shown). */
  hide(frame) {
    this.stopPlace(frame);
    frame.iframe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;border:0;visibility:hidden;';
  }

  /** Frame teardown hook: stop placement and drop the dock if this frame was in it. */
  releaseFrame(frame) {
    this.stopPlace(frame);
    if (this.docked === frame) { this.docked = null; this.#hideEl(); }
  }

  // --- dock ------------------------------------------------------------------

  #hideEl() {
    if (this.el) this.el.style.display = 'none';
  }

  /** Float a viewer frame as the single floating dock, sized by its declared minimums. */
  dock(frame) {
    if (this.docked && this.docked !== frame) this.closeDock(this.docked);
    const min = frame.dock?.minSize || { width: 300, height: 90 };
    const el = this.#dockEl();
    el.style.width = `${clampDim(min.width, 200, 480)}px`;
    el.style.height = `${clampDim(min.height, 56, 360) + 26}px`; // + header
    el.querySelector('.vd-title').textContent = frame.node?.name || frame.record.manifest.name;
    el.style.display = 'flex';
    // Round the frame's bottom corners to match the dock's rounded body.
    this.place(frame, el.querySelector('.vd-body'), 61, '0 0 11px 11px');
    this.docked = frame;
    frame.docked = true;
    frame.channel?.emit('dock:state', { docked: true });
    this.onChange();
  }

  /** Un-dock without destroying — used when a docked frame is re-adopted into a viewer. */
  undock(frame) {
    this.#hideEl();
    if (this.docked === frame) this.docked = null;
    frame.docked = false;
    frame.channel?.emit('dock:state', { docked: false });
  }

  /** Dismiss the dock: the user closed it, or the viewer disabled docking. The frame
   *  is done, so tear it down. */
  closeDock(frame) {
    this.#hideEl();
    if (this.docked === frame) this.docked = null;
    frame.docked = false;
    frame.channel?.emit('dock:state', { docked: false, closed: true });
    this.destroyFrame?.(frame);
    this.onChange();
  }

  #dockEl() {
    if (this.el) return this.el;
    const el = document.createElement('div');
    el.className = 'viewer-dock';
    el.innerHTML = '<div class="vd-bar"><span class="vd-title"></span><button class="vd-expand" title="Reopen">↗</button><button class="vd-close" title="Close">✕</button></div><div class="vd-body"></div>';
    el.querySelector('.vd-expand').addEventListener('click', () => {
      const frame = this.docked;
      if (frame?.node) this.openFile?.(frame.node, frame.openerId);
    });
    el.querySelector('.vd-close').addEventListener('click', () => {
      if (this.docked) this.closeDock(this.docked);
    });
    document.body.appendChild(el);
    this.el = el;
    return el;
  }
}

// Clamp a viewer-declared dock dimension into a sane host range (defaulting to the
// low bound when the viewer gives nothing).
function clampDim(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v || lo));
}
