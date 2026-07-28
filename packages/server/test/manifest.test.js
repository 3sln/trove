// The web app manifest, which is now generated rather than served from a file.
//
// The thing to protect is that this stays a no-op for anyone who has not configured it:
// the defaults have to reproduce the static document that used to live in
// packages/web/public, or upgrading silently renames everyone's installed app.

import { test, expect } from 'bun:test';
import { webManifest, manifestFromEnv, MANIFEST_PATH } from '../src/manifest.js';

test('the defaults are the document that used to be a static file', () => {
  const m = webManifest();
  expect(m).toEqual({
    name: 'Trove',
    short_name: 'Trove',
    description: 'Your self-hosted drive with semantic search, media players, and plugins.',
    start_url: '/',
    display: 'standalone',
    background_color: '#181a1f',
    theme_color: '#181a1f',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  });
});

test('an operator can put their own name on it', () => {
  const m = webManifest(manifestFromEnv({
    TROVE_APP_NAME: 'Acme Files',
    TROVE_APP_SHORT_NAME: 'Files',
    TROVE_APP_DESCRIPTION: 'Everything Acme has ever written down.',
    TROVE_APP_THEME_COLOR: '#0b5cff',
  }));
  expect(m.name).toBe('Acme Files');
  expect(m.short_name).toBe('Files');
  expect(m.description).toBe('Everything Acme has ever written down.');
  expect(m.theme_color).toBe('#0b5cff');
  // Not set separately, so it follows the theme rather than staying on a default that
  // no longer has anything to do with the chosen colour.
  expect(m.background_color).toBe('#0b5cff');
});

test('short_name follows name when only one is given', () => {
  expect(webManifest(manifestFromEnv({ TROVE_APP_NAME: 'Acme Files' })).short_name).toBe('Acme Files');
});

test('an icon type is guessed from the extension, and can be stated', () => {
  expect(webManifest(manifestFromEnv({ TROVE_APP_ICON: '/brand/logo.png', TROVE_APP_ICON_SIZES: '512x512' })).icons)
    .toEqual([{ src: '/brand/logo.png', sizes: '512x512', type: 'image/png', purpose: 'any' }]);
  // An extension nobody recognises is left unstated rather than guessed wrong — the
  // field is optional, and a lie here is worse than an omission.
  expect(webManifest(manifestFromEnv({ TROVE_APP_ICON: '/brand/logo' })).icons[0].type).toBeUndefined();
  expect(webManifest(manifestFromEnv({ TROVE_APP_ICON: '/logo.svg?v=2' })).icons[0].type).toBe('image/svg+xml');
});

test('a full icon array is the escape hatch', () => {
  const icons = [
    { src: '/i/192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/i/mask.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];
  const m = webManifest(manifestFromEnv({ TROVE_APP_ICONS: JSON.stringify(icons) }));
  expect(m.icons).toEqual(icons);
});

test('a malformed icon array is ignored rather than fatal', () => {
  // A typo in an environment variable should not stop a drive from booting.
  const m = webManifest(manifestFromEnv({ TROVE_APP_ICONS: '[{oops' }));
  expect(m.icons).toEqual([{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }]);
  expect(webManifest(manifestFromEnv({ TROVE_APP_ICONS: '[]' })).icons).toHaveLength(1);
});

test('an unusable display mode falls back instead of shipping a broken manifest', () => {
  expect(webManifest(manifestFromEnv({ TROVE_APP_DISPLAY: 'kiosk' })).display).toBe('standalone');
  expect(webManifest(manifestFromEnv({ TROVE_APP_DISPLAY: 'fullscreen' })).display).toBe('fullscreen');
});

test('empty is the same as unset', () => {
  // A container that declares TROVE_APP_NAME= with no value has not chosen a name.
  expect(webManifest(manifestFromEnv({ TROVE_APP_NAME: '' })).name).toBe('Trove');
});

test('the path is the one index.html asks for', () => {
  expect(MANIFEST_PATH).toBe('/manifest.webmanifest');
});
