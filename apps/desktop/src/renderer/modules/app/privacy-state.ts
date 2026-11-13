/**
 * Anonymous / Private: the gateway's privacy mode and the switch between
 * them, with its optimistic state, gateway epochs, send waiters and
 * failed-write recovery.
 */
import { useSyncExternalStore } from 'react';
import type { GatewayPrivacy, GatewayPrivacyMode } from '../../types/bridge';
import { createCachedResource } from './cached-resource';

/** The mode the user last asked for, while the gateway is still applying it. */
let requestedPrivacyMode: GatewayPrivacyMode | null = null;

/** Bumped whenever a switch starts or settles, so a read that spans one can be told apart. */
let privacyGeneration = 0;

/** Bumped when the gateway changes: a privacy write started against the old one must not settle the new one. */
let privacyGatewayEpoch = 0;

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

type PrivacySwitchState = {
  switching: boolean;
  error: string | null;
  /**
   * The mode a switch the user asked for is applying (the chat's key and every
   * connected app's), until the gateway confirms it. The screen shows the mode
   * as pending meanwhile, not in effect: an app can still be routed under the
   * old policy.
   */
  target?: GatewayPrivacyMode | null;
};

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

/**
 * The gateway changed, so whatever the screen shows may not be true of the new
 * one, and a read started against the old one must not settle it. Sending waits
 * until the new gateway has said.
 */
export async function reloadPrivacyForNewGateway(): Promise<void> {
  const thisReload = ++privacyGeneration;
  privacyGatewayEpoch += 1;
  // A choice still on its way was for the old gateway.
  requestedPrivacyMode = null;
  privacyUnconfirmedError = null;
  publishPrivacySwitch({ switching: true, error: null });
  const read = await privacyResource.reload();
  // A newer reload or switch now decides whether sending may go ahead.
  if (thisReload !== privacyGeneration) return;
  if (read) {
    publishPrivacySwitch({ switching: false, error: null });
    return;
  }
  const error = 'Could not read this gateway\'s privacy mode';
  privacyUnconfirmedError = error;
  publishPrivacySwitch({ switching: true, error });
  window.setTimeout(() => { void privacyResource.refresh(); }, PRIVACY_RECHECK_MS);
}

export function getPrivacySwitchState(): PrivacySwitchState {
  return privacySwitchState;
}

/** Settles once no mode change is reaching the gateway. */
export function whenPrivacySwitchSettled(): Promise<void> {
  if (!privacySwitchState.switching) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = subscribePrivacySwitch(() => {
      if (privacySwitchState.switching) return;
      unsubscribe();
      resolve();
    });
  });
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
  if (!shown) {
    // The mode isn't known yet, so there is nothing to switch from; say so
    // rather than look switched while requests go out as before.
    publishPrivacySwitch({ switching: false, error: 'The privacy mode is still loading. Try again in a moment.' });
    return;
  }
  const alreadyRunning = requestedPrivacyMode !== null;
  requestedPrivacyMode = mode;
  privacyUnconfirmedError = null;
  privacyGeneration += 1;
  privacyResource.setData({ ...shown, mode });
  publishPrivacySwitch({ switching: true, error: null, target: mode });
  if (alreadyRunning) return;

  let confirmed: GatewayPrivacy | null = null;
  let error: string | null = null;
  let target: GatewayPrivacyMode;
  const epoch = privacyGatewayEpoch;
  do {
    target = requestedPrivacyMode;
    try {
      const result = await window.antseedDesktop?.gatewaySetPrivacy?.(target);
      if (!result?.ok || !result.privacy) throw new Error(result?.error ?? 'Could not change the privacy mode');
      confirmed = result.privacy;
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      const actual = await window.antseedDesktop?.gatewayGetPrivacy?.()?.catch(() => null);
      confirmed = actual?.ok && actual.privacy ? actual.privacy : null;
    }
    // The gateway changed meanwhile: its reload decides what is shown and when sending goes.
    if (epoch !== privacyGatewayEpoch) return;
    // A choice made meanwhile still applies, even if the write before it failed.
  } while (requestedPrivacyMode !== target);
  requestedPrivacyMode = null;
  privacyGeneration += 1;
  if (!confirmed) {
    // Keep showing what was asked for, held and still pending (not in
    // effect), until the gateway can say.
    privacyUnconfirmedError = error;
    publishPrivacySwitch({ switching: true, error, target });
    window.setTimeout(() => { void privacyResource.refresh(); }, PRIVACY_RECHECK_MS);
    return;
  }
  privacyResource.setData(confirmed);
  publishPrivacySwitch({ switching: false, error });
}
