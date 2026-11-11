/**
 * IPC surface for connected apps: the app list, "Open with" / identity
 * settings, and connecting or disconnecting an app from the gateway.
 */
import { ipcMain } from 'electron';
import {
  type AppLaunchTarget,
  normalizeToolSlugs,
  setAppIdentitySetting,
  setAppLaunchSetting,
} from '../connected-apps/launch-settings.js';
import { appTargetNeedsRestart, restartAppTarget } from '../connected-apps/launcher.js';
import {
  effectiveLaunchTarget,
  effectiveToolSlugs,
  launchTargetIcon,
  readInstalledAppTarget,
} from '../connected-apps/profile-targets.js';
import {
  connectApp,
  disconnectApp,
  getConnectedAppsState,
  listConnectableProfiles,
} from '../connected-apps/patching/connection.js';
import { findConnectableProfile } from '../connected-apps/patching/profiles.js';
import { connectedAppsWslTargetsPath } from '../connected-apps/patching/paths.js';
import { appDownloadUrl } from '../connected-apps/download-links.js';
import { isConfigPatchInstalled } from '@antseed/connected-apps/config-patch';
import { resolveConnectDataDir } from '../runtime/process-manager.js';
import { errorResult } from './results.js';


export function registerConnectedAppsIpc(): void {
  ipcMain.handle('apps:list-profiles', async () => {
    const state = getConnectedAppsState();
    return Promise.all(listConnectableProfiles().map(async (profile) => {
      const launchTarget = effectiveLaunchTarget(profile.name);
      // The associated application's real icon represents the row; the
      // renderer falls back to a drawn brand mark without one.
      const iconDataUri = launchTarget ? await launchTargetIcon(launchTarget.path) : null;
      const connected = state.connected.includes(profile.name);
      // An app the user pointed "Open with" at counts as installed even where the probe misses it.
      const installed = connected || Boolean(launchTarget)
        || (profile.configPatch ? isConfigPatchInstalled(profile.configPatch, connectedAppsWslTargetsPath()) : true);
      const downloadUrl = appDownloadUrl(profile.name);
      return {
        name: profile.name,
        displayName: profile.label,
        appAction: profile.appAction,
        openUrl: profile.openUrl,
        toolName: profile.toolName,
        connected,
        error: state.errors[profile.name] ?? null,
        installed,
        ...(downloadUrl ? { downloadUrl } : {}),
        canRestart: Boolean(launchTarget),
        needsRestart: connected && launchTarget ? await appTargetNeedsRestart(launchTarget, state.connectedAt) : false,
        toolSlugs: effectiveToolSlugs(profile.name, profile.toolSlugs, profile.label),
        ...(iconDataUri ? { iconDataUri } : {}),
        ...(launchTarget ? { launchAppName: launchTarget.name } : {}),
      };
    }));
  });

  ipcMain.handle('apps:connect', async (_event, opts: { name?: string }) => {
    try {
      return { ok: true, state: await connectApp(typeof opts?.name === 'string' ? opts.name : '') };
    } catch (err) {
      return { ...errorResult(err), state: getConnectedAppsState() };
    }
  });

  ipcMain.handle('apps:disconnect', async (_event, opts: { name?: string }) => {
    try {
      return { ok: true, state: await disconnectApp(typeof opts?.name === 'string' ? opts.name : '') };
    } catch (err) {
      return { ...errorResult(err), state: getConnectedAppsState() };
    }
  });

  ipcMain.handle('apps:set-app-launch', (_event, opts: { name?: string; app?: { name?: string; path?: string } | null }) => {
    const name = typeof opts?.name === 'string' ? opts.name : '';
    if (!findConnectableProfile(name)) return { ok: false, error: 'Unknown app.' };
    let target: AppLaunchTarget | null = null;
    if (opts?.app !== null && opts?.app !== undefined) {
      target = readInstalledAppTarget(opts.app);
      if (!target) return { ok: false, error: 'That application could not be found.' };
    }
    setAppLaunchSetting(resolveConnectDataDir(), name, target);
    return { ok: true };
  });

  ipcMain.handle('apps:set-app-identity', (_event, opts: { name?: string; toolSlugs?: unknown }) => {
    const name = typeof opts?.name === 'string' ? opts.name : '';
    if (!findConnectableProfile(name)) return { ok: false, error: 'Unknown app.' };
    const raw = opts?.toolSlugs;
    if (raw !== null && raw !== undefined && !Array.isArray(raw)) {
      return { ok: false, error: 'Client names must be a list.' };
    }
    const slugs = Array.isArray(raw)
      ? normalizeToolSlugs(raw.filter((entry): entry is string => typeof entry === 'string'))
      : null;
    // An empty list clears the override — the profile's defaults apply again.
    setAppIdentitySetting(resolveConnectDataDir(), name, slugs && slugs.length > 0 ? slugs : null);
    return { ok: true };
  });

  ipcMain.handle('apps:restart-app', async (_event, opts: { app?: string }) => {
    const name = typeof opts?.app === 'string' ? opts.app : '';
    const target = effectiveLaunchTarget(name);
    if (!findConnectableProfile(name) || !target) {
      return { ok: false, error: `No app to restart for ${name || 'this profile'}.` };
    }
    const result = await restartAppTarget(target, { force: true, launchIfStopped: true });
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
  });
}
