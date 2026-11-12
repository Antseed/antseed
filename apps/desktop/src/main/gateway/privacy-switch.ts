/**
 * Anonymous / Private changes which models every key on the local gateway can
 * use, not its address or keys. What was read under the old policy (the model
 * list, route previews) is dropped, and each connected app's model list is
 * written again from its key's `/v1/models`.
 */
import type { GatewayPrivacy, GatewayPrivacyMode } from '../../shared/gateway-types.js';

export type PrivacyRead = { privacy: GatewayPrivacy; changed: boolean };

/**
 * A read or switch of the mode in turn with the others (`queue`), `changed`
 * when the operation itself moved the saved mode. The saved mode is taken
 * inside the turn, so an operation queued behind a switch doesn't count the
 * switch's change as its own.
 */
export function privacyInTurn(
  queue: { run: <T>(task: () => Promise<T>) => Promise<T> },
  operation: () => Promise<GatewayPrivacy>,
  savedPrivacy: () => GatewayPrivacyMode,
): Promise<PrivacyRead> {
  return queue.run(async () => {
    const before = savedPrivacy();
    const privacy = await operation();
    return { privacy, changed: savedPrivacy() !== before };
  });
}

export type PrivacySwitchDeps = {
  /**
   * Applies the mode to every key, `changed` when the saved mode moved (judged
   * in turn, like a read); throws for a remote gateway, whose console sets it.
   */
  setPrivacy: (mode: GatewayPrivacyMode) => Promise<PrivacyRead>;
  /** Reads the mode (`privacyInTurn`), bringing every key in line with one the console changed. */
  getPrivacy: () => Promise<PrivacyRead>;
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
    const { privacy, changed } = await deps.setPrivacy(mode);
    // Choosing the mode already in effect leaves every key's models as they were.
    if (changed) policyChanged(deps);
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
  const { privacy, changed } = await deps.getPrivacy();
  if (changed) policyChanged(deps);
  return privacy;
}
