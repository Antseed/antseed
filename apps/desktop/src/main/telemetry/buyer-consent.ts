/**
 * Mirrors the desktop's telemetry choice into the buyer's config file as
 * `telemetry.enabled`. The buyer watches that file and applies the change
 * live, so turning telemetry off in Preferences also stops the buyer's
 * request events without a restart.
 */
import { ACTIVE_CONFIG_PATH } from '../runtime/active-config.js';
import { mergeConfig } from '../runtime/config-io.js';

export async function syncBuyerTelemetryConsent(enabled: boolean, configPath: string = ACTIVE_CONFIG_PATH): Promise<void> {
  try {
    await mergeConfig({ telemetry: { enabled } }, configPath);
  } catch {
    // A config that cannot be written keeps the buyer's previous choice.
  }
}
