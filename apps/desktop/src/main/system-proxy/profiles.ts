/**
 * The catalog of app profiles the system proxy can connect.
 *
 * Packaged profiles ship as JSON next to the app (overridable by env for
 * development); the user's own custom apps are merged in on top. A profile is
 * either a `proxy` kind — the app follows the OS proxy setting — or a
 * `config-patch` kind, where the app has its own config file we edit instead.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveConnectDataDir } from '../runtime/process-manager.js';
import { loadAppLaunchSettings, normalizeToolSlugs } from '../connected-apps/launch-settings.js';
import { customAppToCliProfile, loadCustomApps, type CustomAppRecord } from '../connected-apps/custom.js';
import { mergeWithDefaultAppProfiles } from '@antseed/connected-apps/defaults';
import {
  readConfigPatch,
  readRequiredString,
  readString,
  removeConfigPatch,
  type ConfigPatchDef,
} from '@antseed/connected-apps/config-patch';
import { systemProxyDataDir, systemProxyWslTargetsPath } from './paths.js';

export const DEFAULT_SYSTEM_PROXY_PORT = Number(process.env['ANTSEED_SYSTEM_PROXY_PORT']) || 8378;
export const SYSTEM_PROXY_PROFILES_JSON_ENV = 'ANTSEED_SYSTEM_PROXY_PROFILES_JSON';
export const SYSTEM_PROXY_PROFILES_FILE_ENV = 'ANTSEED_SYSTEM_PROXY_PROFILES_FILE';
export const PACKAGED_SYSTEM_PROXY_PROFILES_RELATIVE = 'system-proxy-profiles.json';

export type DesktopSystemProxyProfile = {
  readonly name: string;
  readonly label: string;
  readonly kind: 'proxy' | 'config-patch';
  readonly method: string;
  readonly domains: readonly string[];
  readonly appAction?: 'none' | 'open-url' | 'open-tool' | 'restart-app';
  readonly openUrl?: string;
  readonly toolName?: string;
  readonly restartAppName?: string;
  readonly configPatch?: ConfigPatchDef;
  /** Default client names (User-Agent product / session-header slugs) that
      attribute wire requests to this app — user overrides win at display. */
  readonly toolSlugs?: readonly string[];
};

export type DesktopSystemProxyProfileMetadata = {
  readonly displayLabel?: string;
  readonly methodLabel?: string;
  readonly appAction?: 'none' | 'open-url' | 'open-tool' | 'restart-app';
  readonly openUrl?: string;
  readonly toolName?: string;
  readonly restartAppName?: string;
};


export const { profiles: SYSTEM_PROXY_PROFILES, raw: SYSTEM_PROXY_PROFILES_RAW } = loadDesktopSystemProxyProfiles();

export function loadDesktopSystemProxyProfiles(env: NodeJS.ProcessEnv = process.env): {
  profiles: readonly DesktopSystemProxyProfile[];
  raw: readonly unknown[];
} {
  const envJson = env[SYSTEM_PROXY_PROFILES_JSON_ENV]?.trim();
  const envFile = env[SYSTEM_PROXY_PROFILES_FILE_ENV]?.trim();
  const packagedFile = packagedSystemProxyProfilesPath();
  const raw = envJson
    || (envFile ? readFileSync(envFile, 'utf8') : '')
    || (packagedFile ? readFileSync(packagedFile, 'utf8') : '');
  const parsed = raw ? JSON.parse(raw) as unknown : [];
  if (!Array.isArray(parsed)) {
    throw new Error(`${SYSTEM_PROXY_PROFILES_JSON_ENV} / ${SYSTEM_PROXY_PROFILES_FILE_ENV} must define a JSON array`);
  }
  const merged = mergeWithDefaultAppProfiles(parsed);
  return {
    profiles: merged.map((profile, index) => normalizeDesktopSystemProxyProfile(profile, index)),
    raw: merged,
  };
}

export function loadCustomAppRecords(): CustomAppRecord[] {
  return loadCustomApps(resolveConnectDataDir());
}

/**
 * A custom app displays under its picked application's name. Deriving it from
 * the launch setting (rather than trusting the record's displayName alone)
 * also fixes records whose application was picked before renames persisted.
 */
export function customAppDisplayName(record: CustomAppRecord): string {
  return loadAppLaunchSettings(resolveConnectDataDir())[record.name]?.name ?? record.displayName;
}

export function customAppDesktopProfile(record: CustomAppRecord): DesktopSystemProxyProfile {
  return {
    name: record.name,
    label: customAppDisplayName(record),
    kind: 'proxy',
    method: 'HTTPS proxy',
    domains: [record.host],
  };
}

/** Packaged profiles plus the user's custom apps, in display order. */
export function allSystemProxyProfiles(): DesktopSystemProxyProfile[] {
  return [...SYSTEM_PROXY_PROFILES, ...loadCustomAppRecords().map(customAppDesktopProfile)];
}

export function packagedSystemProxyProfilesPath(): string | null {
  if (!app.isPackaged || typeof process.resourcesPath !== 'string') return null;
  const filePath = path.join(process.resourcesPath, PACKAGED_SYSTEM_PROXY_PROFILES_RELATIVE);
  return existsSync(filePath) ? filePath : null;
}

export function systemProxyProfilesEnv(): Record<string, string> {
  // The CLI child reads profiles once at startup, so hand it a merged file
  // combining the built-in defaults, the packaged/env profiles, and the
  // user's custom apps.
  const merged = [
    ...SYSTEM_PROXY_PROFILES_RAW,
    ...loadCustomAppRecords().map((record) => customAppToCliProfile({ ...record, displayName: customAppDisplayName(record) })),
  ];
  const filePath = path.join(systemProxyDataDir(), 'profiles.merged.json');
  mkdirSync(systemProxyDataDir(), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return { [SYSTEM_PROXY_PROFILES_FILE_ENV]: filePath };
}

export function normalizeDesktopSystemProxyProfile(value: unknown, index: number): DesktopSystemProxyProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`System Proxy profile at index ${index} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const name = readRequiredString(raw, 'name', index);
  const metadata = readProfileMetadata(raw['metadata']);
  const label = readString(raw, 'displayName') ?? readString(raw, 'label') ?? metadata?.displayLabel ?? `Tool ${index + 1}`;
  const kind = raw['kind'] === 'config-patch' ? 'config-patch' : 'proxy';
  const configPatch = readConfigPatch(raw['configPatch'], name);
  const appAction = readAppAction(raw['appAction']) ?? metadata?.appAction;
  const openUrl = readString(raw, 'openUrl') ?? metadata?.openUrl;
  const toolName = readString(raw, 'toolName') ?? metadata?.toolName;
  const restartAppName = readString(raw, 'restartAppName') ?? metadata?.restartAppName;
  const toolSlugs = normalizeToolSlugs(readStringArray(raw['toolSlugs']));
  return {
    name,
    label,
    kind,
    method: readString(raw, 'method') ?? metadata?.methodLabel ?? (kind === 'config-patch' ? 'Config' : 'Proxy'),
    domains: readStringArray(raw['domains']),
    ...(toolSlugs.length > 0 ? { toolSlugs } : {}),
    ...(appAction ? { appAction } : {}),
    ...(openUrl ? { openUrl } : {}),
    ...(toolName ? { toolName } : {}),
    ...(restartAppName ? { restartAppName } : {}),
    ...(configPatch ? { configPatch } : {}),
  };
}

export function readProfileMetadata(value: unknown): DesktopSystemProxyProfileMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const appAction = readAppAction(raw['appAction']);
  const metadata: DesktopSystemProxyProfileMetadata = {
    ...(readString(raw, 'displayLabel') ? { displayLabel: readString(raw, 'displayLabel') } : {}),
    ...(readString(raw, 'methodLabel') ? { methodLabel: readString(raw, 'methodLabel') } : {}),
    ...(appAction ? { appAction } : {}),
    ...(readString(raw, 'openUrl') ? { openUrl: readString(raw, 'openUrl') } : {}),
    ...(readString(raw, 'toolName') ? { toolName: readString(raw, 'toolName') } : {}),
    ...(readString(raw, 'restartAppName') ? { restartAppName: readString(raw, 'restartAppName') } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function readAppAction(value: unknown): DesktopSystemProxyProfile['appAction'] {
  return value === 'open-url' || value === 'open-tool' || value === 'restart-app' || value === 'none'
    ? value
    : undefined;
}

export function removeAllConfigPatches(): void {
  for (const profile of SYSTEM_PROXY_PROFILES) {
    if (profile.kind !== 'config-patch' || !profile.configPatch) continue;
    removeConfigPatch(profile.configPatch, systemProxyWslTargetsPath());
  }
}
