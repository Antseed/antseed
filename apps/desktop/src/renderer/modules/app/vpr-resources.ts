import type {
  ConnectedAppProfile,
  GatewayKeyInfo,
  GatewaySavings,
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

/**
 * What the buyer's usage would have cost at retail. Polled like the usage
 * tiles beside it, since apps keep making requests; a read that fails (the
 * buyer still starting) keeps the last figures.
 */
export const savingsResource = createCachedResource<GatewaySavings>({
  pollMs: 30_000,
  async load() {
    const savings = await window.antseedDesktop?.gatewayGetSavings?.();
    if (!savings) throw new Error('No savings to show yet');
    return savings;
  },
});

export const installedAppsResource = createCachedResource<InstalledAppEntry[]>({
  async load() {
    const result = await window.antseedDesktop?.listInstalledApps?.();
    if (!result?.ok) throw new Error(result?.error ?? 'Could not list applications');
    return result.apps ?? [];
  },
});

export {
  privacyResource,
  clearPrivacySwitchError,
  reloadPrivacyForNewGateway,
  getPrivacySwitchState,
  whenPrivacySwitchSettled,
  usePrivacySwitch,
  requestPrivacyMode,
} from './privacy-state';
