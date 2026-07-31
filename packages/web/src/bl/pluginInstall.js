// Install flow: turn an uploaded .zip or a URL into a parsed package, assess its
// trust (signature + domain verification), and present the pre-install review so
// the user can make an informed decision before any plugin code runs.
//
// Takes the four resources it actually needs rather than the whole `app`. That is what let
// the last two actions stop leasing `app` — and a lease that names notifications, plugins,
// workbench and social says what an install touches, where `app` said nothing at all.

import { parsePackage, fetchPackage, reviewSummary, displayName } from '../platform/pluginPackage.js';
import { pluginId } from '@3sln/trove/core/plugins/identity.js';

/** @typedef {{notifications: object, plugins: object, workbench: object, social: object}} InstallResources */

/** @param {InstallResources} r */
export async function beginInstallFromFile(r, file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await review(r, parsePackage(bytes));
  } catch (err) {
    r.notifications.error(`Couldn't read the plugin: ${err.message}`);
  }
}

/** @param {InstallResources} r */
export async function beginInstallFromUrl(r, url) {
  try {
    const pkg = await fetchPackage(url, (u, o) => fetch(u, o));
    await review(r, pkg);
  } catch (err) {
    r.notifications.error(`Couldn't fetch the plugin: ${err.message}`);
  }
}

async function review(r, pkg) {
  const label = displayName(pkg.manifest);
  if (r.plugins.plugins.has(pluginId(pkg.manifest))) {
    r.notifications.warn(`“${label}” is already installed.`);
    return;
  }
  // Trust assessment can hit the network (domain assetlinks); do it before review.
  let trust = { status: 'unverified' };
  try {
    trust = await r.plugins.assessTrust(pkg);
  } catch { /* offline / unreachable */ }
  const summary = reviewSummary(pkg, trust);
  r.workbench.showDialog({
    kind: 'plugin-review',
    summary,
    isAdmin: !!r.social.state.admin,
    onInstall: async (grants) => {
      r.workbench.closeDialog();
      // Account installs upload the package + run a handshake that can take a while —
      // switch to the plugins view (which shows the plugin's loading state) and hold a
      // sticky "Installing…" toast so the user isn't left staring at nothing.
      r.workbench.setActivity('plugins');
      const pending = r.notifications.info(`Installing “${label}”…`, { sticky: true });
      try {
        await r.plugins.install(pkg, { grants, trust });
        r.notifications.dismiss(pending);
        r.notifications.success(`Installed “${label}”`);
      } catch (err) {
        r.notifications.dismiss(pending);
        r.notifications.error(`Install failed: ${err.message}`);
      }
    },
  });
}
