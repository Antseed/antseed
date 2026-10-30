/**
 * What the desktop tells the CLI processes it starts about telemetry: that
 * the desktop hosts them (so the buyer tags its events `buyer_host=desktop`
 * and the CLI sends no command events of its own), the desktop session they
 * belong to, and an off switch when desktop telemetry cannot run at all
 * (development builds, the kill switch, no PostHog project) or the user
 * has opted out. The opt-out also travels through the config file
 * (`telemetry.enabled`), which a running buyer re-reads, so the toggle
 * applies without a restart; the env switch makes sure a buyer started
 * later stays off even if that file could not be written.
 */
export const TELEMETRY_HOST_ENV = 'ANTSEED_TELEMETRY_HOST';
export const TELEMETRY_HOST_SESSION_ID_ENV = 'ANTSEED_TELEMETRY_HOST_SESSION_ID';
export const TELEMETRY_OFF_ENV = 'ANTSEED_TELEMETRY';

let hostSessionId: string | null = null;
let available = false;
let userOptedOut = false;

export function setDesktopTelemetryHost(input: { sessionId: string; available: boolean; userOptedOut?: boolean }): void {
  hostSessionId = input.sessionId;
  available = input.available;
  userOptedOut = input.userOptedOut ?? false;
}

export function setDesktopTelemetryUserOptedOut(optedOut: boolean): void {
  userOptedOut = optedOut;
}

export function desktopTelemetryChildEnv(): Record<string, string> {
  return {
    [TELEMETRY_HOST_ENV]: 'desktop',
    ...(hostSessionId ? { [TELEMETRY_HOST_SESSION_ID_ENV]: hostSessionId } : {}),
    ...(available && !userOptedOut ? {} : { [TELEMETRY_OFF_ENV]: '0' }),
  };
}
