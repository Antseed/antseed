/**
 * The connected-app catalog in a typed, ready-to-use form, plus a per-app
 * status snapshot (installed / connected / config path).
 */
import { mergeWithDefaultAppProfiles } from './defaults.js';
import {
  configPatchPaths,
  isConfigPatchConnected,
  isConfigPatchInstalled,
  readConfigPatch,
  readRequiredString,
  readString,
  type ConfigPatchDef,
} from './config-patch.js';

export type ConnectedAppProfile = {
  readonly name: string;
  readonly displayName: string;
  readonly configPatch: ConfigPatchDef;
};

/**
 * Every config-patch profile in display order: the built-in defaults, with
 * any `external` raw profiles merged in on top (same rules as the desktop).
 * Proxy-kind profiles have no config to patch and are skipped.
 */
export function loadConnectedAppProfiles(external: readonly unknown[] = []): ConnectedAppProfile[] {
  const profiles: ConnectedAppProfile[] = [];
  mergeWithDefaultAppProfiles(external).forEach((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const raw = value as Record<string, unknown>;
    if (raw['kind'] !== 'config-patch') return;
    const name = readRequiredString(raw, 'name', index);
    const configPatch = readConfigPatch(raw['configPatch'], name);
    if (!configPatch) return;
    profiles.push({
      name,
      displayName: readString(raw, 'displayName') ?? readString(raw, 'label') ?? name,
      configPatch,
    });
  });
  return profiles;
}

export function findConnectedAppProfile(
  name: string,
  profiles: readonly ConnectedAppProfile[] = loadConnectedAppProfiles(),
): ConnectedAppProfile | undefined {
  const wanted = name.trim().toLowerCase();
  return profiles.find((profile) => profile.name.toLowerCase() === wanted);
}

export type ConnectedAppStatus = {
  readonly name: string;
  readonly displayName: string;
  readonly format: ConfigPatchDef['format'];
  readonly installed: boolean;
  readonly connected: boolean;
  /** Primary config file the patch edits (first candidate for multi-path formats). */
  readonly configPath: string;
  readonly configPaths: readonly string[];
};

export function connectedAppStatus(profile: ConnectedAppProfile, wslTargetsFile?: string): ConnectedAppStatus {
  const configPaths = configPatchPaths(profile.configPatch);
  return {
    name: profile.name,
    displayName: profile.displayName,
    format: profile.configPatch.format,
    installed: isConfigPatchInstalled(profile.configPatch, wslTargetsFile),
    connected: isConfigPatchConnected(profile.configPatch, wslTargetsFile),
    configPath: configPaths[0] ?? profile.configPatch.configPath,
    configPaths,
  };
}
