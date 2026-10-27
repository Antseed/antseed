/**
 * What the desktop tells the CLI processes it starts about telemetry: that
 * the desktop hosts them (so the buyer tags its events `buyer_host=desktop`
 * and the CLI sends no command events of its own), the desktop session they
 * belong to, and an off switch when desktop telemetry cannot run at all
 * (development builds, the kill switch, no PostHog project). The user's
 * opt-out travels through the config file instead (`telemetry.enabled`),
 * which a running buyer re-reads, so the toggle applies without a restart.
 */
export const TELEMETRY_HOST_ENV = 'ANTSEED_TELEMETRY_HOST';
export const TELEMETRY_HOST_SESSION_ID_ENV = 'ANTSEED_TELEMETRY_HOST_SESSION_ID';
export const TELEMETRY_OFF_ENV = 'ANTSEED_TELEMETRY';

let hostSessionId: string | null = null;
let available = false;

export function setDesktopTelemetryHost(input: { sessionId: string; available: boolean }): void {
  hostSessionId = input.sessionId;
  available = input.available;
}

export function desktopTelemetryChildEnv(): Record<string, string> {
  return {
    [TELEMETRY_HOST_ENV]: 'desktop',
    ...(hostSessionId ? { [TELEMETRY_HOST_SESSION_ID_ENV]: hostSessionId } : {}),
    ...(available ? {} : { [TELEMETRY_OFF_ENV]: '0' }),
  };
}
