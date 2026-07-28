// The web app manifest.
//
// There was already a manifest — a static file in packages/web/public, baked at build
// time and identical in every deployment. That is fine for exactly one drive and wrong
// for a self-hosted product: an operator running this for a team wants their name on
// the installed icon, not "Trove". Changing it meant editing a file inside the package
// and rebuilding, which the shipped-dist model has just made something nobody does.
//
// So it is generated per request from configuration, like everything else an operator
// sets. The static file is gone rather than kept as a fallback: two documents that must
// agree, one of which is only reachable in development, is how they stop agreeing.
//
// No `node:` imports — this is on the runtime-agnostic side and has to load on Workers.

export const MANIFEST_PATH = '/manifest.webmanifest';

const DISPLAY_MODES = ['standalone', 'fullscreen', 'minimal-ui', 'browser'];

const ICON_TYPES = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
};

/** Guess from the extension, since we cannot read the file — it may not even be ours. */
function iconType(src) {
  const dot = src.lastIndexOf('.');
  return dot === -1 ? undefined : ICON_TYPES[src.slice(dot).toLowerCase().split('?')[0]];
}

/**
 * Read the operator's choices out of the environment.
 *
 * Everything is optional and everything has a default that produces the document the
 * static file used to contain, so a deployment that sets none of this is unchanged.
 *
 * @param {Record<string, string|undefined>} env
 */
export function manifestFromEnv(env = {}) {
  const m = {};
  const set = (key, value) => { if (value !== undefined && value !== '') m[key] = value; };

  set('name', env.TROVE_APP_NAME);
  set('shortName', env.TROVE_APP_SHORT_NAME);
  set('description', env.TROVE_APP_DESCRIPTION);
  set('themeColor', env.TROVE_APP_THEME_COLOR);
  set('backgroundColor', env.TROVE_APP_BACKGROUND_COLOR);
  set('display', env.TROVE_APP_DISPLAY);
  set('startUrl', env.TROVE_APP_START_URL);
  set('icon', env.TROVE_APP_ICON);
  set('iconSizes', env.TROVE_APP_ICON_SIZES);
  set('iconType', env.TROVE_APP_ICON_TYPE);

  // The escape hatch. A drive that wants a maskable icon, six raster sizes and a
  // monochrome badge is not going to be expressible in flat variables, and inventing a
  // mini-language for it would be worse than accepting the array the spec already
  // defines. Malformed JSON is ignored rather than fatal: a typo here should not stop a
  // drive from booting.
  if (env.TROVE_APP_ICONS) {
    try {
      const icons = JSON.parse(env.TROVE_APP_ICONS);
      if (Array.isArray(icons) && icons.length) m.icons = icons;
    } catch { /* keep the single-icon path */ }
  }
  return m;
}

/**
 * Build the manifest document.
 *
 * @param {object} [m] the `manifest` block of the server config
 * @returns {object} a W3C web app manifest
 */
export function webManifest(m = {}) {
  const name = m.name || 'Trove';
  const theme = m.themeColor || '#181a1f';
  const src = m.icon || '/icon.svg';

  const icons = m.icons || [{
    src,
    sizes: m.iconSizes || 'any',
    // An SVG is resolution-independent and `any` is honest about it; a raster file at
    // `any` is a lie the browser will believe and then scale badly, so a host pointing
    // at a PNG is expected to say what size it is.
    type: m.iconType || iconType(src),
    purpose: 'any',
  }];

  return {
    name,
    short_name: m.shortName || name,
    description: m.description || 'Your self-hosted drive with semantic search, media players, and plugins.',
    start_url: m.startUrl || '/',
    display: DISPLAY_MODES.includes(m.display) ? m.display : 'standalone',
    background_color: m.backgroundColor || theme,
    theme_color: theme,
    icons: icons.map((i) => Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined))),
  };
}
