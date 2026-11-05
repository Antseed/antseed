/**
 * What the desktop tells the CLI processes it starts about telemetry: that
 * the desktop hosts them (so the buyer tags its events `buyer_host=desktop`
 * and the CLI sends no command events of its own), the desktop session they
 * belong to, and an off switch.
 *
 * The user's choice travels through the config file (`telemetry.enabled`),
 * which a running buyer re-reads, so turning telemetry on or off in
 * Preferences applies without a restart. A child's environment cannot change
 * after it starts, so the env off switch is kept for what does not change
 * while the desktop runs: desktop telemetry cannot run at all (development
 * builds, the kill switches, no PostHog project), or the user's choice has
 * not been written to the config yet, so a buyer started then cannot send on
 * a stale `telemetry.enabled: true`.
 */
export const TELEMETRY_HOST_ENV = 'ANTSEED_TELEMETRY_HOST';
export const TELEMETRY_HOST_SESSION_ID_ENV = 'ANTSEED_TELEMETRY_HOST_SESSION_ID';
export const TELEMETRY_OFF_ENV = 'ANTSEED_TELEMETRY';

let hostSessionId: string | null = null;
let available = false;
let choiceInConfig = false;

export function setDesktopTelemetryHost(input: { sessionId: string; available: boolean }): void {
  hostSessionId = input.sessionId;
  available = input.available;
}

/** Call once the config holds the user's current choice (true), or when writing it failed (false). */
export function setDesktopTelemetryChoiceInConfig(written: boolean): void {
  choiceInConfig = written;
}

export function desktopTelemetryChildEnv(): Record<string, string> {
  return {
    [TELEMETRY_HOST_ENV]: 'desktop',
    ...(hostSessionId ? { [TELEMETRY_HOST_SESSION_ID_ENV]: hostSessionId } : {}),
    ...(available && choiceInConfig ? {} : { [TELEMETRY_OFF_ENV]: '0' }),
  };
}
