export const DEFAULT_DASHBOARD_PORT = 3117;
export const POLL_INTERVAL_MS = 5000;

export const DEFAULT_ROUTER_RUNTIME = 'local';

export const ROUTER_PACKAGE_ALIASES: Record<string, string> = {
  local: '@antseed/router-local',
  'claude-code': '@antseed/router-local',
  'router-local': '@antseed/router-local',
  'antseed-router-claude-code': '@antseed/router-local',
  'antseed-router-local': '@antseed/router-local',
  '@antseed/router-local': '@antseed/router-local',
};

export const UI_MESSAGES = {
  desktopBridgeUnavailable:
    'Desktop bridge unavailable: preload failed to inject API. Restart app after main/preload compile.',
  localServicePortInUse: 'Local data service port already in use; reusing the existing service.',
  buyerAutoStarted: 'Buyer runtime auto-started for local proxy chat.',
} as const;

/**
 * The Antseed Points site; VITE_POINTS_URL overrides it at build time.
 * TODO: replace the placeholder default once the Points domain is chosen.
 */
export const POINTS_URL: string = (import.meta.env?.VITE_POINTS_URL || 'https://antseedpoints.com').replace(/\/+$/, '');

/** The Points page for the buyer wallet (points belong to the buyer, not the authorized wallet). */
export function pointsUrl(buyerAddress: string | null | undefined): string {
  return buyerAddress ? `${POINTS_URL}/me?address=${encodeURIComponent(buyerAddress.toLowerCase())}` : `${POINTS_URL}/me`;
}
