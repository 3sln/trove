// Built-in openers, registered through the same contribution system plugins use.
// Each declares a selector (extensions / mime) and a component(node, ui) → vnode.
// The editor area picks the highest-priority opener whose selector matches.

import { dd, Observable } from '../../../runtime.js';
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

function imageOpener(node, ui) {
  return div({ className: 'viewer image' }, img({ src: ui.platform.api.downloadUrl(node.id), alt: node.name }));
}

function audioOpener(node, ui) {
  return div({ className: 'viewer', $styling: { display: 'grid', placeItems: 'center', gap: '16px', padding: '40px' } },
    icon('file-audio', { size: 48 }),
    span({ $styling: { color: 'var(--text-dim)' } }, node.name),
    audio({ src: ui.platform.api.downloadUrl(node.id), controls: true, $styling: { width: 'min(520px, 90%)' } }),
  );
}

function videoOpener(node, ui) {
  return div({ className: 'viewer', $styling: { display: 'grid', placeItems: 'center', background: '#000' } },
    video({ src: ui.platform.api.downloadUrl(node.id), controls: true, $styling: { maxWidth: '100%', maxHeight: '100%' } }),
  );
}

function fallbackOpener(node, ui) {
  return div({ className: 'viewer' },
    div({ className: 'fallback' },
      icon('file', { size: 44 }),
      span({ $styling: { fontWeight: 600 } }, node.name),
      span(`${node.contentType || 'Unknown type'} · ${bytes(node.size)}`),
      span({ $styling: { color: 'var(--text-faint)', maxWidth: '340px' } }, 'No preview available for this file type. Install a plugin that handles it, or download the file.'),
      button({ className: 'btn primary' }, icon('download', { size: 15 }), 'Download')
        .on({ click: () => ui.exec('explorer.download', node) }),
    ),
  );
}

function pluginOpenerView(opener, node, ui) {
  // A plugin-provided opener renders inside its own iframe; we surface its panel.
  Promise.resolve(opener.open?.(node, {})).catch(() => {});
  return div({ className: 'viewer' },
    div({ className: 'fallback' },
      icon('plug', { size: 40 }),
      span(`Opened with ${opener.title} (plugin)`),
      button({ className: 'btn' }, 'Show plugin panel').on({ click: () => ui.platform.workbench.openPluginPanel(opener.pluginId) }),
    ),
  );
}

function errorView(message) {
  return div({ className: 'viewer' }, div({ className: 'fallback' }, icon('warn', { size: 40 }), span(message || 'Failed to open')));
}
