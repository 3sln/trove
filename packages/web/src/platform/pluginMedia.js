// MediaController — bridges a plugin frame's playback to the OS via
// navigator.mediaSession, so a sandboxed audio/video viewer surfaces real transport
// controls (lock screen, media keys, notification shade).
//
// The host owns the single global mediaSession; the LAST frame to touch it becomes
// the owner. OS actions fire back over that frame's own RPC channel, so a handler is
// only ever wired to a live frame — and the handlers a frame registered are released
// when it goes away (otherwise the OS would call into a dead channel).

export class MediaController {
  constructor() {
    this.owner = null; // the frame currently driving navigator.mediaSession
  }

  #session() {
    return typeof navigator !== 'undefined' ? navigator.mediaSession : null;
  }

  /** Apply one media operation for `frame`. kind: metadata|playbackState|position|action|clear */
  apply(frame, kind, params = {}) {
    const ms = this.#session();
    if (!ms) return { ok: false };
    if (frame && kind !== 'clear') { this.owner = frame; frame.mediaOwner = true; }
    try {
      if (kind === 'metadata') {
        ms.metadata = typeof MediaMetadata !== 'undefined'
          ? new MediaMetadata({ title: params.title || '', artist: params.artist || '', album: params.album || '', artwork: params.artwork || [] })
          : ms.metadata;
      } else if (kind === 'playbackState') {
        ms.playbackState = params.state || 'none';
      } else if (kind === 'position' && ms.setPositionState) {
        ms.setPositionState({ duration: params.duration || 0, position: params.position || 0, playbackRate: params.playbackRate || 1 });
      } else if (kind === 'action') {
        ms.setActionHandler?.(params.action, params.on ? () => frame?.channel?.emit('media:action', { action: params.action }) : null);
        // Remember which actions this frame registered, so we can release them when
        // the frame goes away (otherwise the OS handler points at a dead channel).
        if (frame) { frame.mediaActions ||= new Set(); params.on ? frame.mediaActions.add(params.action) : frame.mediaActions.delete(params.action); }
      } else if (kind === 'clear') {
        if (frame && this.owner && this.owner !== frame) return { ok: true }; // don't clear someone else's session
        this.releaseActions(frame);
        ms.metadata = null;
        ms.playbackState = 'none';
        this.owner = null;
      }
    } catch { /* unsupported action/state */ }
    return { ok: true };
  }

  /** Detach the OS media-transport handlers a frame registered (on teardown). */
  releaseActions(frame) {
    const ms = this.#session();
    if (!ms || !frame?.mediaActions) return;
    for (const action of frame.mediaActions) { try { ms.setActionHandler?.(action, null); } catch { /* ignore */ } }
    frame.mediaActions.clear();
  }

  /** Frame teardown: give up the session if this frame owned it, then drop its handlers. */
  releaseFrame(frame) {
    if (this.owner === frame) { this.owner = null; this.apply(frame, 'clear', {}); }
    this.releaseActions(frame); // drop handlers even if this frame wasn't the owner
  }
}
