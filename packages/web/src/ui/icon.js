// Inline SVG icons. One function, a path table, sized via viewBox 24. Using
// dodo's element helpers so icons are just vnodes like everything else.

import { dd } from '../runtime.js';

const { svg, h } = dd;

// Each entry is an array of <path>/<primitive> specs (attrs use SVG names).
const PATHS = {
  link: [{ d: 'M10 13a5 5 0 0 0 7.07 0l3-3A5 5 0 0 0 13 3l-1.5 1.5' }, { d: 'M14 11a5 5 0 0 0-7.07 0l-3 3A5 5 0 0 0 11 21l1.5-1.5' }],
  folder: [{ d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }],
  'folder-open': [{ d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2M3 9h16.5a1 1 0 0 1 .97 1.24l-1.5 6A1 1 0 0 1 18 17H5a2 2 0 0 1-2-2z' }],
  file: [{ d: 'M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z' }, { d: 'M14 3v5h5' }],
  'file-text': [{ d: 'M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z' }, { d: 'M14 3v5h5M9 13h6M9 17h6M9 9h2' }],
  'file-image': [{ d: 'M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z' }, { d: 'M14 3v5h5' }, { d: 'M8.5 15l2-2 3 3 2-1.5' }, { d: 'M10 12a1 1 0 1 0 0-.01' }],
  'file-audio': [{ d: 'M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z' }, { d: 'M14 3v5h5M10 12v5M13 10v9' }],
  'file-video': [{ d: 'M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z' }, { d: 'M14 3v5h5M10 12l4 2.5-4 2.5z' }],
  book: [{ d: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z' }, { d: 'M4 19a2 2 0 0 1 2-2h13' }],
  search: [{ d: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5' }],
  command: [{ d: 'M8 6a2 2 0 1 0-2 2h12a2 2 0 1 0-2-2v12a2 2 0 1 0 2-2H6a2 2 0 1 0 2 2z' }],
  gear: [{ d: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z' }, { d: 'M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 2h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12a7 7 0 0 0 .1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 22h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6A7 7 0 0 0 19 12z' }],
  upload: [{ d: 'M12 16V4M7 9l5-5 5 5M4 20h16' }],
  download: [{ d: 'M12 4v12M7 11l5 5 5-5M4 20h16' }],
  trash: [{ d: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6' }],
  'new-folder': [{ d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }, { d: 'M12 11v5M9.5 13.5h5' }],
  refresh: [{ d: 'M20 11a8 8 0 1 0-.5 4M20 5v6h-6' }],
  'chevron-right': [{ d: 'M9 6l6 6-6 6' }],
  'chevron-left': [{ d: 'M15 6l-6 6 6 6' }],
  'chevron-down': [{ d: 'M6 9l6 6 6-6' }],
  close: [{ d: 'M6 6l12 12M18 6L6 18' }],
  tag: [{ d: 'M4 4h6.5a1 1 0 0 1 .7.3l8.5 8.5a1 1 0 0 1 0 1.4l-5.5 5.5a1 1 0 0 1-1.4 0L4.3 11.2a1 1 0 0 1-.3-.7V4z' }, { d: 'M8 8a0.6 0.6 0 1 0 0-.01' }],
  play: [{ d: 'M8 5v14l11-7z', fill: 'currentColor', stroke: 'none' }],
  pause: [{ d: 'M8 5h3v14H8zM13 5h3v14h-3z', fill: 'currentColor', stroke: 'none' }],
  'skip-back': [{ d: 'M11 6v12L3 12zM13 6l8 6-8 6zM21 6v12', fill: 'none' }],
  'skip-forward': [{ d: 'M13 6v12l8-6zM3 6l8 6-8 6zM3 6v12' }],
  'back-30': [{ d: 'M11 8a7 7 0 1 0 7 7' }, { d: 'M11 4l-3 4 4 1' }],
  'fwd-30': [{ d: 'M13 8a7 7 0 1 1-7 7' }, { d: 'M13 4l3 4-4 1' }],
  plug: [{ d: 'M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0zM12 18v3' }],
  bell: [{ d: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9z' }, { d: 'M13.73 21a2 2 0 0 1-3.46 0' }],
  files: [{ d: 'M4 4h9l3 3v3M8 8h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z' }],
  dots: [{ d: 'M5 12h.01M12 12h.01M19 12h.01' }],
  check: [{ d: 'M5 12l5 5L20 6' }],
  plus: [{ d: 'M12 5v14M5 12h14' }],
  'arrow-up': [{ d: 'M12 19V5M6 11l6-6 6 6' }],
  star: [{ d: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z' }],
  info: [{ d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01' }],
  warn: [{ d: 'M12 3l9 16H3zM12 10v4M12 17h.01' }],
  x: [{ d: 'M6 6l12 12M18 6L6 18' }],
};

// Map a node to an icon name via the shared file-type classifier.
export { iconForKind as iconForNode } from '../bl/fileType.js';

export function icon(name, { size = 18, strokeWidth = 1.6, className } = {}) {
  const specs = PATHS[name] || PATHS.file;
  return svg(
    {
      $attrs: {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', 'stroke-width': strokeWidth,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      },
      className: className || '',
    },
    ...specs.map((s) => h('path', { $attrs: filterAttrs(s) })),
  );
}

function filterAttrs(s) {
  const out = { d: s.d };
  if (s.fill) out.fill = s.fill;
  if (s.stroke) out.stroke = s.stroke;
  return out;
}
