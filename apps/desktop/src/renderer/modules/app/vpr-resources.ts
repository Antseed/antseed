import { useSyncExternalStore } from 'react';
import type {
  ConnectedAppProfile,
  GatewayKeyInfo,
  GatewayPrivacy,
  GatewayPrivacyMode,
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

/** The mode the user last asked for, while the gateway is still applying it. */
let requestedPrivacyMode: GatewayPrivacyMode | null = null;

/** Bumped whenever a switch starts or settles, so a read that spans one can be told apart. */
let privacyGeneration = 0;

/** A write failed and the read after it did too: the gateway's mode is unknown. Sending stays held. */
let privacyUnconfirmedError: string | null = null;

/** How soon to read the mode again when it is unknown; polling alone would hold sends for a minute. */
const PRIVACY_RECHECK_MS = 5_000;

/** Anonymous or Private, as the desktop key's routing policy has it. */
export const privacyResource = createCachedResource<GatewayPrivacy>({
  pollMs: 60_000,
  async load(): Promise<GatewayPrivacy> {
    const startedAt = privacyGeneration;
    const result = await window.antseedDesktop?.gatewayGetPrivacy?.();
    if (!result?.ok || !result.privacy) throw new Error(result?.error ?? 'Could not read the privacy mode');
    // A read that began before a switch settled says nothing about the result.
    const shown = privacyResource.getSnapshot().data;
    if (startedAt !== privacyGeneration && shown) return shown;
    // A poll that lands mid-switch must not flip the screen back.
    if (requestedPrivacyMode) return { ...result.privacy, mode: requestedPrivacyMode };
    if (privacyUnconfirmedError !== null) {
      const error = privacyUnconfirmedError;
      privacyUnconfirmedError = null;
      publishPrivacySwitch({ switching: false, error });
    }
    return result.privacy;
  },
});

type PrivacySwitchState = { switching: boolean; error: string | null };

let privacySwitchState: PrivacySwitchState = { switching: false, error: null };
const privacySwitchListeners = new Set<() => void>();

function publishPrivacySwitch(next: PrivacySwitchState): void {
  privacySwitchState = next;
  for (const listener of privacySwitchListeners) listener();
}

function subscribePrivacySwitch(listener: () => void): () => void {
  privacySwitchListeners.add(listener);
  return () => { privacySwitchListeners.delete(listener); };
}

/** A failed switch says nothing about a gateway the user has since moved to. */
export function clearPrivacySwitchError(): void {
  if (privacySwitchState.error) publishPrivacySwitch({ ...privacySwitchState, error: null });
}

export function getPrivacySwitchState(): PrivacySwitchState {
  return privacySwitchState;
}

/** Whether a mode change is still reaching the gateway. Sending waits for it. */
export function usePrivacySwitch(): PrivacySwitchState {
  return useSyncExternalStore(subscribePrivacySwitch, getPrivacySwitchState, getPrivacySwitchState);
}

/**
 * Shows the new mode at once and applies it to the key's routing policy behind
 * the scenes, which takes seconds because each step runs the CLI. Flipping
 * again mid-way applies only the latest choice. A failed write may still have
 * landed, so the mode is read back; if that fails too, sending stays held until
 * a read succeeds. Nothing goes out under a policy the screen doesn't show.
 */
export async function requestPrivacyMode(mode: GatewayPrivacyMode): Promise<void> {
  const shown = privacyResource.getSnapshot().data;
  if (!shown) return;
  const alreadyRunning = requestedPrivacyMode !== null;
  requestedPrivacyMode = mode;
  privacyUnconfirmedError = null;
  privacyGeneration += 1;
  privacyResource.setData({ ...shown, mode });
  publishPrivacySwitch({ switching: true, error: null });
  if (alreadyRunning) return;

  let confirmed: GatewayPrivacy | null = null;
  let error: string | null = null;
  try {
    let target: GatewayPrivacyMode;
    do {
      target = requestedPrivacyMode;
      const result = await window.antseedDesktop?.gatewaySetPrivacy?.(target);
      if (!result?.ok || !result.privacy) throw new Error(result?.error ?? 'Could not change the privacy mode');
      confirmed = result.privacy;
    } while (requestedPrivacyMode !== target);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    const actual = await window.antseedDesktop?.gatewayGetPrivacy?.().catch(() => null);
    confirmed = actual?.ok && actual.privacy ? actual.privacy : null;
  }
  requestedPrivacyMode = null;
  privacyGeneration += 1;
  if (!confirmed) {
    // Keep showing what was asked for, held, until the gateway can say.
    privacyUnconfirmedError = error;
    publishPrivacySwitch({ switching: true, error });
    window.setTimeout(() => { void privacyResource.refresh(); }, PRIVACY_RECHECK_MS);
    return;
  }
  privacyResource.setData(confirmed);
  publishPrivacySwitch({ switching: false, error });
}
