// Install flow: turn an uploaded .zip or a URL into a parsed package, assess its
// trust (signature + domain verification), and present the pre-install review so
// the user can make an informed decision before any plugin code runs.
//
// Takes the four resources it actually needs rather than the whole `app`. That is what let
// the last two actions stop leasing `app` — and a lease that names notifications, plugins,
// workbench and social says what an install touches, where `app` said nothing at all.

import { parsePackage, fetchPackage, reviewSummary, displayName } from '../platform/pluginPackage.js';
import { pluginId } from '@3sln/trove/core/plugins/identity.js';
import { installPolicyFor } from './trust.js';

/**
 * What an install touches. The parameter list below is the same set spelled out, so a lease
 * that forgot one is a missing ARGUMENT at the top of the function rather than an
 * `undefined` several lines in — which is how a missing `overlay` came to be reported to
 * the user as "Couldn't read the plugin", about a file that read perfectly.
 *
 * @typedef {{notifications: object, overlay: object, plugins: object, social: object, workbench: object}} InstallResources
 */

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

/** @param {InstallResources} r */
async function review({ notifications, overlay, plugins, social, workbench }, pkg) {
  const label = displayName(pkg.manifest);
  if (plugins.plugins.has(pluginId(pkg.manifest))) {
    notifications.warn(`“${label}” is already installed.`);
    return;
  }
  // Trust assessment can hit the network (domain assetlinks); do it before review.
  let trust = { status: 'unverified' };
  try {
    trust = await plugins.assessTrust(pkg);
  } catch { /* offline / unreachable */ }

  // A tampered package is refused here rather than presented with a warning. The review
  // dialog exists to let someone weigh what a plugin asks for against who is asking; a
  // signature that does not match its contents means the "who" is unknown and the contents
  // are not what was signed, so there is nothing to weigh. See installPolicyFor.
  const policy = installPolicyFor(trust);
  if (!policy.allowed) {
    notifications.error(`“${label}” was not installed. ${policy.detail}`, { sticky: true });
    return;
  }

  const summary = reviewSummary(pkg, trust);
  overlay.set({ dialog: {
    kind: 'plugin-review',
    summary,
    policy,
    isAdmin: !!social.state.admin,
    onInstall: async (grants) => {
      overlay.set({ dialog: null });
      // Account installs upload the package + run a handshake that can take a while —
      // switch to the plugins view (which shows the plugin's loading state) and hold a
      // sticky "Installing…" toast so the user isn't left staring at nothing.
      workbench.set({ activity: 'plugins', sidebarVisible: true });
      const pending = notifications.info(`Installing “${label}”…`, { sticky: true });
      try {
        await plugins.install(pkg, { grants, trust });
        notifications.dismiss(pending);
        notifications.success(`Installed “${label}”`);
      } catch (err) {
        notifications.dismiss(pending);
        notifications.error(`Install failed: ${err.message}`);
      }
    },
  } });
}
