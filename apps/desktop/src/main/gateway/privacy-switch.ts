/**
 * Anonymous / Private changes which models every key on the local gateway can
 * use, not its address or keys. What was read under the old policy (the model
 * list, route previews) is dropped, and each connected app's model list is
 * written again from its key's `/v1/models`.
 */
import type { GatewayPrivacy, GatewayPrivacyMode } from '../../shared/gateway-types.js';

export type PrivacySwitchDeps = {
  /** Applies the mode to every key; throws for a remote gateway, whose console sets it. */
  setPrivacy: (mode: GatewayPrivacyMode) => Promise<GatewayPrivacy>;
  /** Reads the mode, bringing every key in line with one the console changed. */
  getPrivacy: () => Promise<GatewayPrivacy>;
  /** The mode as last saved by the desktop. */
  savedPrivacy: () => GatewayPrivacyMode;
  gatewayMode: () => 'local' | 'remote';
  /** Drops the model list and route previews read under the old policy. */
  clearCaches: () => void;
  /**
   * Writes each connected app's model list again. Not awaited: the switch is
   * in effect once the keys have it, and an app's config can take seconds
   * (Codex's model catalog runs Codex), while the chat holds sends until the
   * switch returns. Running apps aren't restarted: their address and key still
   * work, and the Apps view marks them "Restart required".
   */
  refreshApps: () => void;
};

function policyChanged(deps: PrivacySwitchDeps): void {
  deps.clearCaches();
  deps.refreshApps();
}

export async function switchPrivacy(mode: GatewayPrivacyMode, deps: PrivacySwitchDeps): Promise<GatewayPrivacy> {
  try {
    const privacy = await deps.setPrivacy(mode);
    policyChanged(deps);
    return privacy;
  } catch (err) {
    // A switch that failed partway may have changed some keys already. A
    // remote gateway's switch is refused before anything changes.
    if (deps.gatewayMode() === 'local') policyChanged(deps);
    throw err;
  }
}

/** A read that found the mode changed in the console has moved every key to it. */
export async function readPrivacy(deps: PrivacySwitchDeps): Promise<GatewayPrivacy> {
  const before = deps.savedPrivacy();
  const privacy = await deps.getPrivacy();
  if (deps.savedPrivacy() !== before) policyChanged(deps);
  return privacy;
}
