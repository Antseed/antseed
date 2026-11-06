/**
 * The catalog of apps the desktop can connect to the gateway.
 *
 * Built-in profiles come from @antseed/connected-apps; packaged extras ship
 * as JSON next to the app (overridable by env for development). Every
 * connectable profile is a `config-patch`: the app's own config file is
 * pointed at the gateway with an API key.
 */
import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeToolSlugs } from '../launch-settings.js';
import { mergeWithDefaultAppProfiles } from '@antseed/connected-apps/defaults';
import {
  readConfigPatch,
  readRequiredString,
  readString,
  removeConfigPatch,
  type ConfigPatchDef,
} from '@antseed/connected-apps/config-patch';
import { connectedAppsWslTargetsPath } from './paths.js';

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

/**
 * Claude Code's model list only takes Claude-named models, so it can't offer
 * the network's. The CLI's `antseed apps` still connects it.
 */
const NOT_CONNECTED_BY_DESKTOP: ReadonlySet<string> = new Set(['claude-code']);

/** Apps the desktop stopped connecting; a patch from an earlier version gets removed. */
export function retiredDesktopProfiles(): DesktopSystemProxyProfile[] {
  return SYSTEM_PROXY_PROFILES.filter((profile) => NOT_CONNECTED_BY_DESKTOP.has(profile.name));
}

/** Profiles that can be connected: those that patch the app's own config. */
export function connectableProfiles(): DesktopSystemProxyProfile[] {
  return SYSTEM_PROXY_PROFILES.filter((profile) => (
    profile.kind === 'config-patch' && profile.configPatch && !NOT_CONNECTED_BY_DESKTOP.has(profile.name)
  ));
}

export function findConnectableProfile(name: string): DesktopSystemProxyProfile | undefined {
  return connectableProfiles().find((profile) => profile.name === name);
}

export function packagedSystemProxyProfilesPath(): string | null {
  if (!app.isPackaged || typeof process.resourcesPath !== 'string') return null;
  const filePath = path.join(process.resourcesPath, PACKAGED_SYSTEM_PROXY_PROFILES_RELATIVE);
  return existsSync(filePath) ? filePath : null;
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
  for (const profile of connectableProfiles()) {
    removeConfigPatch(profile.configPatch!, connectedAppsWslTargetsPath());
  }
}
