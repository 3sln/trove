// Install flow: turn an uploaded .zip or a URL into a parsed package, assess its
// trust (signature + domain verification), and present the pre-install review so
// the user can make an informed decision before any plugin code runs.

import { parsePackage, fetchPackage, reviewSummary, displayName } from '../platform/pluginPackage.js';
import { pluginId } from '@3sln/trove/core/plugins/identity.js';

export async function beginInstallFromFile(app, file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await review(app, parsePackage(bytes));
  } catch (err) {
    app.platform.notifications.error(`Couldn't read the plugin: ${err.message}`);
  }
}

export async function beginInstallFromUrl(app, url) {
  try {
    const pkg = await fetchPackage(url, (u, o) => fetch(u, o));
    await review(app, pkg);
  } catch (err) {
    app.platform.notifications.error(`Couldn't fetch the plugin: ${err.message}`);
  }
}

async function review(app, pkg) {
  const label = displayName(pkg.manifest);
  if (app.platform.plugins.plugins.has(pluginId(pkg.manifest))) {
    app.platform.notifications.warn(`“${label}” is already installed.`);
    return;
  }
  // Trust assessment can hit the network (domain assetlinks); do it before review.
  let trust = { status: 'unverified' };
  try {
    trust = await app.platform.plugins.assessTrust(pkg);
  } catch { /* offline / unreachable */ }
  const summary = reviewSummary(pkg, trust);
  app.platform.workbench.showDialog({
    kind: 'plugin-review',
    summary,
    isAdmin: !!app.social.state.admin,
    onInstall: async (grants) => {
      app.platform.workbench.closeDialog();
      // Account installs upload the package + run a handshake that can take a while —
      // switch to the plugins view (which shows the plugin's loading state) and hold a
      // sticky "Installing…" toast so the user isn't left staring at nothing.
      app.platform.workbench.setActivity('plugins');
      const pending = app.platform.notifications.info(`Installing “${label}”…`, { sticky: true });
      try {
        await app.platform.plugins.install(pkg, { grants, trust });
        app.platform.notifications.dismiss(pending);
        app.platform.notifications.success(`Installed “${label}”`);
      } catch (err) {
        app.platform.notifications.dismiss(pending);
        app.platform.notifications.error(`Install failed: ${err.message}`);
      }
    },
  });
}
