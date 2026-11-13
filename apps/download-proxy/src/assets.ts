/**
 * Download-target parsing and release-asset matching.
 *
 * The URL scheme is /vpr/<platform>-<arch> (e.g. /vpr/mac-arm64). Asset
 * matching mirrors apps/website/src/lib/useLatestDesktopDownload.ts: match by
 * regex against the asset filename rather than constructing URLs, so the
 * proxy self-corrects when electron-builder changes its artifact naming.
 *
 * Mac matches only the .dmg (fresh installs) — the -mac.zip assets are what
 * electron-updater downloads for updates, and keeping the updater on GitHub
 * while the website uses this proxy is exactly what separates fresh-install
 * telemetry from update traffic.
 */

export type ProxyPlatform = 'mac' | 'win' | 'linux';
export type ProxyArch = 'arm64' | 'x64';

export interface Target {
  platform: ProxyPlatform;
  arch: ProxyArch;
}

const TARGET_RE = /^(mac|win|linux)-(arm64|x64)$/;

/** Parse a /vpr/<segment> path segment into a target, or null if malformed. */
export function parseTarget(segment: string): Target | null {
  const match = TARGET_RE.exec(segment);
  if (!match) return null;
  return {platform: match[1] as ProxyPlatform, arch: match[2] as ProxyArch};
}

const EXTENSION_FOR: Record<ProxyPlatform, RegExp> = {
  mac: /\.dmg$/i,
  win: /\.exe$/i,
  // AppImage runs on any distro; .deb stays a releases-page choice.
  linux: /\.AppImage$/i,
};

/** Pick the release asset for a target, or null if none is published. */
export function matchAsset<A extends {name: string}>(assets: A[], target: Target): A | null {
  const wantArm64 = target.arch === 'arm64';
  return (
    assets.find(asset => {
      if (/\.blockmap$/i.test(asset.name)) return false;
      if (!EXTENSION_FOR[target.platform].test(asset.name)) return false;
      return /arm64/i.test(asset.name) === wantArm64;
    }) ?? null
  );
}
