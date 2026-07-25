// Built-in openers, registered through the same contribution system plugins use.
// Each declares a selector (extensions / mime) and a component(node, ui) → vnode.
// The editor area picks the highest-priority opener whose selector matches.

import { dd, Observable, ObservableSubject, watch } from '../../../runtime.js';
import { icon } from '../../icon.js';
import { bytes } from '../../format.js';
import { audiobookOpener } from './audiobook.js';

const { div, pre, img, span, button, video, audio } = dd;

export function registerBuiltinOpeners(platform) {
  const reg = platform.contributions.openers;

  reg.register({
    id: 'core.audiobook', title: 'Audiobook Player', priority: 50,
    selector: { ext: ['.m4b', '.m4a'], mime: ['audio/mp4', 'audio/x-m4b'] },
    component: audiobookOpener,
  });

  reg.register({
    id: 'core.audio', title: 'Audio Player', priority: 20,
    selector: { mime: ['audio/*'], ext: ['.mp3', '.flac', '.wav', '.opus', '.ogg'] },
    component: audioOpener,
  });

  reg.register({
    id: 'core.video', title: 'Video Player', priority: 20,
    selector: { mime: ['video/*'], ext: ['.mp4', '.webm', '.mkv', '.mov'] },
    component: videoOpener,
  });

  reg.register({
    id: 'core.image', title: 'Image Viewer', priority: 20,
    selector: { mime: ['image/*'], ext: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif'] },
    component: imageOpener,
  });

  reg.register({
    id: 'core.text', title: 'Text Viewer', priority: 10,
    selector: {
      mime: ['text/*', 'application/json'],
      ext: ['.txt', '.md', '.json', '.js', '.mjs', '.ts', '.jsx', '.tsx', '.css', '.html', '.xml', '.yaml', '.yml', '.toml', '.ini', '.log', '.csv', '.py', '.rb', '.go', '.rs', '.sh', '.c', '.h', '.cpp', '.java'],
    },
    component: textOpener,
  });
}

/** Render a node with a resolved opener; falls back gracefully. */
export function renderOpener(node, openerId, ui) {
  const opener = ui.platform.contributions.openers.get(openerId);
  if (opener?.component) {
    try {
      return opener.component(node, ui);
    } catch (err) {
      return errorView(err.message);
    }
  }
  if (opener?.pluginId) return pluginOpenerView(opener, node, ui);
  return fallbackOpener(node, ui);
}

// ---- component openers -----------------------------------------------------

function textOpener(node, ui) {
  const src = Observable.fromAsync(() => ui.platform.api.readText(node.id));
  return dd.alias(() =>
    ui.platform.reactive.watch(
      src,
      (text) => div({ className: 'viewer text' }, pre(text)),
      {
        placeholder: () => div({ className: 'viewer' }, div({ className: 'loading' }, div({ className: 'spinner' }), span('Loading…'))),
        error: (e) => errorView(e.message),
      },
    ),
  )();
}

// A media element (img/audio/video) sets its `src` to a download URL that can 404 or
// hold undecodable bytes. Those failures surface only as an async `error` event on the
// element itself (media error events don't bubble), which would otherwise leave a
// broken glyph / black box with no message. `mediaWithError` passes an `onError` the
// caller MUST wire onto the actual media element, and swaps in the download fallback
// (with a reason) the moment it fires.
const MEDIA_ERR = "This file couldn't be loaded — it may be missing or in an unsupported format.";
function mediaWithError(node, ui, makeEl) {
  const state$ = new ObservableSubject({ error: null });
  const onError = () => state$.next({ error: MEDIA_ERR });
  const el = makeEl(onError);
  return dd.alias(() =>
    watch(state$, (s) => (s.error ? fallbackOpener(node, ui, s.error) : el)),
  )();
}

function imageOpener(node, ui) {
  return mediaWithError(node, ui, (onError) =>
    div({ className: 'viewer image' }, img({ src: ui.platform.api.downloadUrl(node.id), alt: node.name }).on({ error: onError })),
  );
}

function audioOpener(node, ui) {
  return mediaWithError(node, ui, (onError) =>
    div({ className: 'viewer', $styling: { display: 'grid', placeItems: 'center', gap: '16px', padding: '40px' } },
      icon('file-audio', { size: 48 }),
      span({ $styling: { color: 'var(--text-dim)' } }, node.name),
      audio({ src: ui.platform.api.downloadUrl(node.id), controls: true, $styling: { width: 'min(520px, 90%)' } }).on({ error: onError }),
    ),
  );
}

function videoOpener(node, ui) {
  return mediaWithError(node, ui, (onError) =>
    div({ className: 'viewer', $styling: { display: 'grid', placeItems: 'center', background: '#000' } },
      video({ src: ui.platform.api.downloadUrl(node.id), controls: true, $styling: { maxWidth: '100%', maxHeight: '100%' } }).on({ error: onError }),
    ),
  );
}

function fallbackOpener(node, ui, reason) {
  return div({ className: 'viewer' },
    div({ className: 'fallback' },
      icon(reason ? 'warn' : 'file', { size: 44 }),
      span({ $styling: { fontWeight: 600 } }, node.name),
      span(`${node.contentType || 'Unknown type'} · ${bytes(node.size)}`),
      span({ $styling: { color: 'var(--text-faint)', maxWidth: '340px' } },
        reason || 'No preview available for this file type. Install a plugin that handles it, or download the file.'),
      button({ className: 'btn primary' }, icon('download', { size: 15 }), 'Download')
        .on({ click: () => ui.exec('explorer.download', node) }),
    ),
  );
}

function pluginOpenerView(opener, node, ui) {
  // A plugin opener renders in its OWN sandboxed iframe (spawned by mountViewer with
  // the plugin's capabilities). That iframe is not a child here — it's a host-owned
  // position:fixed overlay whose box tracks this .pv-host element (moving an <iframe>
  // in the DOM would reload it). $attach hands .pv-host to mountViewer as the tracking
  // target; $detach lets it dock or tear down. `.opaque()` keeps dodo from reconciling
  // these (host-managed) nodes so their lifecycle hooks stay stable across re-renders.
  // A .pv-status overlay shows a spinner until the plugin opens the file (the iframe
  // is transparent while loading) and an error if it never does.
  return div({ className: 'viewer plugin-viewer' },
    div({ className: 'pv-status' }).on({
      $attach: (el) => {
        el.innerHTML = '<div class="loading"><div class="spinner"></div><span>Opening…</span></div>';
        el._ready = () => { el.style.display = 'none'; };
        el._error = (msg) => { el.style.display = 'grid'; el.innerHTML = ''; el.appendChild(errorEl(msg)); };
      },
    }).opaque(),
    div({ className: 'pv-host' }).on({
      $attach: (el) => {
        const status = el.parentElement?.querySelector('.pv-status');
        el._detach = ui.platform.plugins.mountViewer(opener.pluginId, el, node, opener.id, {
          onReady: () => status?._ready?.(),
          onError: (msg) => status?._error?.(msg || 'This viewer failed to load'),
        });
      },
      $detach: (el) => { el._detach?.(); el._detach = null; },
    }).opaque(),
  );
}

// A plain DOM error node for the imperatively-managed .pv-status overlay.
function errorEl(message) {
  const wrap = document.createElement('div');
  wrap.className = 'fallback';
  const s = document.createElement('span');
  s.textContent = message || 'Failed to open';
  wrap.appendChild(s);
  return wrap;
}

function errorView(message) {
  return div({ className: 'viewer' }, div({ className: 'fallback' }, icon('warn', { size: 40 }), span(message || 'Failed to open')));
}
