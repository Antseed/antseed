import type {
  ConnectedAppProfile,
  GatewayKeyInfo,
  GatewayPrivacy,
  GatewayStatus,
  InstalledAppEntry,
} from '../../types/bridge';
import { createCachedResource } from './cached-resource';

const POLL_MS = 3_000;

/** Connectable apps, each with whether it is connected to the gateway. */
export const appsResource = createCachedResource<ConnectedAppProfile[]>({
  pollMs: POLL_MS,
  async load() {
    return (await window.antseedDesktop?.appsListProfiles?.()) ?? [];
  },
});

export type GatewaySnapshot = {
  status: GatewayStatus;
  keyInfo: GatewayKeyInfo | null;
};

/** The gateway the desktop uses, and what it reports for the desktop key. */
export const gatewayResource = createCachedResource<GatewaySnapshot>({
  pollMs: 5_000,
  async load() {
    const bridge = window.antseedDesktop;
    if (!bridge?.gatewayGetStatus) throw new Error('Gateway unavailable');
    const status = await bridge.gatewayGetStatus();
    const keyInfo = status.reachable && status.hasKey ? (await bridge.gatewayGetKeyInfo?.()) ?? null : null;
    return { status, keyInfo };
  },
});

export const installedAppsResource = createCachedResource<InstalledAppEntry[]>({
  async load() {
    const result = await window.antseedDesktop?.listInstalledApps?.();
    if (!result?.ok) throw new Error(result?.error ?? 'Could not list applications');
    return result.apps ?? [];
  },
});

/** Anonymous or Private, as the desktop key's routing policy has it. */
export const privacyResource = createCachedResource<GatewayPrivacy>({
  pollMs: 60_000,
  async load() {
    const result = await window.antseedDesktop?.gatewayGetPrivacy?.();
    if (!result?.ok || !result.privacy) throw new Error(result?.error ?? 'Could not read the privacy mode');
    return result.privacy;
  },
});
