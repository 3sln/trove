// Install flow: turn an uploaded .zip or a URL into a parsed package, assess its
// trust (signature + domain verification), and present the pre-install review so
// the user can make an informed decision before any plugin code runs.

import { parsePackage, fetchPackage, reviewSummary } from '../platform/pluginPackage.js';

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
  if (app.platform.plugins.plugins.has(pkg.manifest.id)) {
    app.platform.notifications.warn(`“${pkg.manifest.name}” is already installed.`);
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
      try {
        await app.platform.plugins.install(pkg, { grants, trust });
        app.platform.notifications.success(`Installed “${pkg.manifest.name}”`);
        app.platform.workbench.setActivity('plugins');
      } catch (err) {
        app.platform.notifications.error(`Install failed: ${err.message}`);
      }
    },
  });
}
