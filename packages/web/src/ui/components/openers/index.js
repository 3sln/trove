// Built-in openers, registered through the same contribution system plugins use.
// Each declares a selector (extensions / mime) and a component(node, ui) → vnode.
// The editor area picks the highest-priority opener whose selector matches.

import { dd, cell, fromAsync, watch } from '../../../runtime.js';
import { icon } from '../../icon.js';
import { bytes } from '../../format.js';
import { markdownOpener } from './markdown.js';

const { div, pre, img, span, button, video, audio } = dd;

// Built-ins register the same way a plugin's manifest declares an opener — same
// registry, same `match` selector, same priority ordering. The only difference is
// that a built-in supplies a `component` (it runs in the host) where a plugin
// supplies an `entry` module (it runs in its own sandboxed frame).
const BUILT_IN = {
  'core.audio': {
    title: 'Audio Player', priority: 20,
    match: { mime: ['audio/*'], ext: ['.mp3', '.flac', '.wav', '.opus', '.ogg', '.m4a', '.m4b'] },
    component: audioOpener,
  },
  'core.video': {
    title: 'Video Player', priority: 20,
    match: { mime: ['video/*'], ext: ['.mp4', '.webm', '.mkv', '.mov'] },
    component: videoOpener,
  },
  'core.image': {
    title: 'Image Viewer', priority: 20,
    match: { mime: ['image/*'], ext: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif'] },
    component: imageOpener,
  },
  // Markdown outranks the plain text viewer: a document that links its sources is how
  // things are grouped now, so those links have to be clickable by default.
  'core.markdown': {
    title: 'Markdown', priority: 30,
    match: { ext: ['.md', '.markdown'], mime: ['text/markdown'] },
    component: markdownOpener,
  },
  'core.text': {
    title: 'Text Viewer', priority: 10,
    match: {
      mime: ['text/*', 'application/json'],
      ext: ['.txt', '.md', '.json', '.js', '.mjs', '.ts', '.jsx', '.tsx', '.css', '.html', '.xml', '.yaml', '.yml', '.toml', '.ini', '.log', '.csv', '.py', '.rb', '.go', '.rs', '.sh', '.c', '.h', '.cpp', '.java'],
    },
    component: textOpener,
  },
};

export function registerBuiltinOpeners(platform) {
  for (const [name, spec] of Object.entries(BUILT_IN)) {
    platform.contributions.register(name, { type: 'opener', ...spec });
  }
}

/** Render a node with a resolved opener; falls back gracefully. */
export function renderOpener(node, openerId, ui) {
  const opener = ui.platform.contributions.get(openerId);
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

// How much of a text file the viewer will pull and draw. A drive holds logs, CSV
// exports and database dumps in the hundreds of megabytes; reading one whole just to
// show its beginning buffers the entire file in the tab and then asks the browser to
// lay out ten million characters. Both halves are bounded here — the Range request
// means the bytes never arrive, not merely that they aren't drawn.
const TEXT_VIEW_BYTES = 512 * 1024;

function textOpener(node, ui) {
  const src = fromAsync(() => ui.platform.api.readTextCapped(node.id, { maxBytes: TEXT_VIEW_BYTES, size: node.size }));
  return dd.alias(() =>
    ui.platform.reactive.watch(
      src,
      ({ text, truncated, total }) => div({ className: 'viewer text' },
        pre(text),
        // Say what is missing rather than trailing off. A viewer that silently shows
        // the first slice of a file is worse than one that refuses: the reader believes
        // they have seen the end of it.
        truncated
          ? div({ className: 'md-truncated' },
            `Showing the first ${Math.round(text.length / 1024)} KB${total ? ` of ${(total / 1048576).toFixed(1)} MB` : ''}. `,
            span('Download the file to read all of it.'))
          : null,
      ),
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
  const state = cell({ error: null });
  const onError = () => state.setValue({ error: MEDIA_ERR });
  const el = makeEl(onError);
  return dd.alias(() =>
    watch(state, (s) => (s.error ? fallbackOpener(node, ui, s.error) : el)),
  )();
}

function imageOpener(node, ui) {
  return mediaWithError(node, ui, (onError) =>
    div({ className: 'viewer image' }, img({ src: ui.platform.api.downloadUrl(node.id), alt: node.name }).on({ error: onError })),
  );
}

function audioOpener(node, ui) {
  return mediaWithError(node, ui, (onError) =>
    div({ className: 'viewer', $styling: { display: 'grid', 'place-items': 'center', gap: '16px', padding: '40px' } },
      icon('file-audio', { size: 48 }),
      span({ $styling: { color: 'var(--text-dim)' } }, node.name),
      audio({ src: ui.platform.api.downloadUrl(node.id), controls: true, $styling: { width: 'min(520px, 90%)' } }).on({ error: onError }),
    ),
  );
}

function videoOpener(node, ui) {
  return mediaWithError(node, ui, (onError) =>
    div({ className: 'viewer', $styling: { display: 'grid', 'place-items': 'center', background: '#000' } },
      video({ src: ui.platform.api.downloadUrl(node.id), controls: true, $styling: { 'max-width': '100%', 'max-height': '100%' } }).on({ error: onError }),
    ),
  );
}

function fallbackOpener(node, ui, reason) {
  return div({ className: 'viewer' },
    div({ className: 'fallback' },
      icon(reason ? 'warn' : 'file', { size: 44 }),
      span({ $styling: { 'font-weight': 600 } }, node.name),
      span(`${node.contentType || 'Unknown type'} · ${bytes(node.size)}`),
      span({ $styling: { color: 'var(--text-faint)', 'max-width': '340px' } },
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
