// The plugin's background entry.
//
// Deliberately almost empty, and that is the shape rather than an omission: an opener runs
// in its OWN frame (`src/player.js`), so everything this plugin actually does happens
// there. What is left for a background entry is one-time setup — and an audiobook player
// has none: no storage to migrate, no network endpoint to reach, no command to register.
//
// It exists because a manifest names an `entry`, and because the alternative — pointing
// `entry` at the opener — would run the whole player in a frame that never gets a file,
// which is a confusing way to spend a document.

import { activate } from 'trove';

activate(async () => {});
