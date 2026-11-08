/**
 * The catalog of apps the desktop can connect to the gateway.
 *
 * Built-in profiles come from @antseed/connected-apps. Every connectable
 * profile is a `config-patch`: the app's own config file is pointed at the
 * gateway with an API key.
 */
import { normalizeToolSlugs } from '../launch-settings.js';
import { DEFAULT_APP_PROFILES } from '@antseed/connected-apps/defaults';
import {
  readConfigPatch,
  readRequiredString,
  readString,
  removeConfigPatch,
  type ConfigPatchDef,
} from '@antseed/connected-apps/config-patch';
import { connectedAppsWslTargetsPath } from './paths.js';
import { removeEach } from './remove-all.js';

export type DesktopSystemProxyProfile = {
  readonly name: string;
  readonly label: string;
  readonly kind: 'proxy' | 'config-patch';
  readonly appAction?: 'none' | 'open-url' | 'open-tool' | 'restart-app';
  readonly openUrl?: string;
  readonly toolName?: string;
  readonly restartAppName?: string;
  readonly configPatch?: ConfigPatchDef;
  /** Default client names (User-Agent product / session-header slugs) that
      attribute wire requests to this app — user overrides win at display. */
  readonly toolSlugs?: readonly string[];
};

const SYSTEM_PROXY_PROFILES: readonly DesktopSystemProxyProfile[] = DEFAULT_APP_PROFILES.map(
  (profile, index) => normalizeDesktopSystemProxyProfile(profile, index),
);

/**
 * Claude Code's model list only takes Claude-named models, so it can't offer
 * the network's. The CLI's `antseed apps` still connects it.
 */
const NOT_CONNECTED_BY_DESKTOP: ReadonlySet<string> = new Set(['claude-code']);

/** Apps the desktop stopped connecting; a patch from an earlier version gets removed. */
export function retiredDesktopProfiles(): DesktopSystemProxyProfile[] {
  return SYSTEM_PROXY_PROFILES.filter((profile) => NOT_CONNECTED_BY_DESKTOP.has(profile.name));
}

/** A profile the desktop connects by patching the app's own config. */
export type ConnectableProfile = DesktopSystemProxyProfile & {
  readonly kind: 'config-patch';
  readonly configPatch: ConfigPatchDef;
};

/** Profiles that can be connected: those that patch the app's own config. */
export function connectableProfiles(): ConnectableProfile[] {
  return SYSTEM_PROXY_PROFILES.filter((profile): profile is ConnectableProfile => (
    profile.kind === 'config-patch' && Boolean(profile.configPatch) && !NOT_CONNECTED_BY_DESKTOP.has(profile.name)
  ));
}

export function findConnectableProfile(name: string): ConnectableProfile | undefined {
  return connectableProfiles().find((profile) => profile.name === name);
}

export function normalizeDesktopSystemProxyProfile(value: unknown, index: number): DesktopSystemProxyProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`System Proxy profile at index ${index} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const name = readRequiredString(raw, 'name', index);
  const label = readString(raw, 'displayName') ?? readString(raw, 'label') ?? `Tool ${index + 1}`;
  const kind = raw['kind'] === 'config-patch' ? 'config-patch' : 'proxy';
  const configPatch = readConfigPatch(raw['configPatch'], name);
  const appAction = readAppAction(raw['appAction']);
  const openUrl = readString(raw, 'openUrl');
  const toolName = readString(raw, 'toolName');
  const restartAppName = readString(raw, 'restartAppName');
  const toolSlugs = normalizeToolSlugs(readStringArray(raw['toolSlugs']));
  return {
    name,
    label,
    kind,
    ...(toolSlugs.length > 0 ? { toolSlugs } : {}),
    ...(appAction ? { appAction } : {}),
    ...(openUrl ? { openUrl } : {}),
    ...(toolName ? { toolName } : {}),
    ...(restartAppName ? { restartAppName } : {}),
    ...(configPatch ? { configPatch } : {}),
  };
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readAppAction(value: unknown): DesktopSystemProxyProfile['appAction'] {
  return value === 'open-url' || value === 'open-tool' || value === 'restart-app' || value === 'none'
    ? value
    : undefined;
}

export function removeAllConfigPatches(log: (line: string) => void): void {
  removeEach(
    connectableProfiles(),
    (profile) => { removeConfigPatch(profile.configPatch, connectedAppsWslTargetsPath()); },
    (profile, err) => { log(`${profile.label}: could not remove Antseed from its config: ${err instanceof Error ? err.message : String(err)}`); },
  );
}
