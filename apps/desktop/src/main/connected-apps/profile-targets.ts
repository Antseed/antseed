/**
 * Which application, icon and tool slugs an app profile currently resolves to.
 *
 * A profile's launch target is the user's explicit "Open with" pick when they
 * made one, and otherwise a default discovered from the installed-app list.
 * Both the system-proxy handlers and the tray read through here so the answer
 * is the same everywhere.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { toolDesktopAppNames } from '../../shared/tool-resume.js';
import { resolveConnectDataDir } from '../runtime/process-manager.js';
import {
  loadAppIdentitySettings,
  loadAppLaunchSettings,
  normalizeToolSlugs,
  type AppLaunchTarget,
} from './launch-settings.js';
import { installedAppIcon, listInstalledApplications } from './installed.js';
import { cachedInstalledApplications } from './launcher.js';
import { isAppsFolderTarget } from './windows-start-menu.js';
import { fetchCustomAppSiteMetadata, loadCustomApps, saveCustomApps } from './custom.js';

/** Known tools with a desktop app (OpenCode, Codex) get a launch target by
    default when the app is installed — no manual "Open with" pick needed.
    Resolved once per run; a user override always wins. */
export const defaultLaunchTargetCache = new Map<string, AppLaunchTarget | null>();

export function defaultLaunchTargetForProfile(profileName: string): AppLaunchTarget | null {
  const appNames = toolDesktopAppNames(profileName);
  if (appNames.length === 0) return null;
  if (process.platform === 'darwin') {
    for (const appName of appNames) {
      for (const dir of ['/Applications', path.join(homedir(), 'Applications')]) {
        const bundle = path.join(dir, `${appName}.app`);
        if (existsSync(bundle)) return { name: appName, path: bundle };
      }
    }
    return null;
  }
  if (process.platform === 'win32') {
    const listed = listInstalledApplications();
    if (!listed.ok) return null;
    for (const appName of appNames) {
      const found = listed.apps.find((entry) => entry.name.toLowerCase() === appName.toLowerCase());
      if (found) return found;
    }
    return null;
  }
  return null;
}

export function effectiveLaunchTarget(profileName: string): AppLaunchTarget | null {
  const override = loadAppLaunchSettings(resolveConnectDataDir())[profileName];
  if (override) return override;
  if (!defaultLaunchTargetCache.has(profileName)) {
    defaultLaunchTargetCache.set(profileName, defaultLaunchTargetForProfile(profileName));
  }
  return defaultLaunchTargetCache.get(profileName) ?? null;
}

/** Client names attributing wire requests to a profile: the user's override
    when set, else the profile's packaged defaults, else slugs derived from
    the profile name AND display name — a profile named 'vendor' displayed as
    'Tool' yields ['vendor', 'tool'], so tool-cli chats attribute to the app
    even when its internal name differs from its brand name. */
export function effectiveToolSlugs(profileName: string, defaults: readonly string[] | undefined, displayName?: string): string[] {
  const override = loadAppIdentitySettings(resolveConnectDataDir())[profileName];
  if (override && override.length > 0) return override;
  if (defaults && defaults.length > 0) return [...defaults];
  return normalizeToolSlugs([profileName, ...(displayName ? [displayName] : [])]);
}

/** Icon of an installed application by launcher path, cached per run — the
    profile list is polled, so extraction must not repeat. */
export const launchIconCache = new Map<string, Promise<string | null>>();

export function launchTargetIcon(targetPath: string): Promise<string | null> {
  let cached = launchIconCache.get(targetPath);
  if (!cached) {
    cached = installedAppIcon(targetPath);
    launchIconCache.set(targetPath, cached);
  }
  return cached;
}

/**
 * A custom app entry is identified by its picked application, so choosing one
 * renames the record (name + icon); clearing the pick reverts to the API
 * host's site metadata. Packaged profiles keep their own names — they have no
 * custom record to update.
 */
export async function syncCustomAppDisplay(profileName: string, target: AppLaunchTarget | null): Promise<void> {
  const dataDir = resolveConnectDataDir();
  const records = loadCustomApps(dataDir);
  const record = records.find((entry) => entry.name === profileName);
  if (!record) return;
  let displayName: string;
  let iconDataUri: string | undefined;
  if (target) {
    displayName = target.name;
    iconDataUri = (await installedAppIcon(target.path)) ?? undefined;
  } else {
    const metadata = await fetchCustomAppSiteMetadata(record.host);
    displayName = metadata.title ?? record.host;
    iconDataUri = metadata.iconDataUri;
  }
  saveCustomApps(dataDir, records.map((entry) => {
    if (entry.name !== profileName) return entry;
    const { iconDataUri: _dropped, ...rest } = entry;
    return { ...rest, displayName, ...(iconDataUri ? { iconDataUri } : {}) };
  }));
}

/** Validate a renderer-passed installed-app reference (name + launcher path). */
export function readInstalledAppTarget(value: unknown): AppLaunchTarget | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const appName = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  const appPath = typeof raw['path'] === 'string' ? raw['path'].trim() : '';
  if (!appName || !appPath) return null;
  // A packaged app is addressed by AppUserModelID, so there is no path to
  // stat — validate it against the enumerated list instead.
  if (isAppsFolderTarget(appPath)) {
    return cachedInstalledApplications().some((entry) => entry.path === appPath)
      ? { name: appName, path: appPath }
      : null;
  }
  const extension = path.extname(appPath).toLowerCase();
  if (!['.app', '.lnk', '.exe'].includes(extension) || !existsSync(appPath)) return null;
  return { name: appName, path: appPath };
}

