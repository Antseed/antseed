import {useEffect, useState} from 'react';
import ExecutionEnvironment from '@docusaurus/ExecutionEnvironment';
import {isMobileGetStartedVisitor} from './useMobileGetStarted';

/**
 * Resolves the Antseed Desktop download URL for the visitor's OS + arch.
 *
 * Download CTAs point at our download proxy (a Cloudflare Worker on
 * download.antseed.com, see apps/download-proxy) instead of GitHub release
 * assets directly:
 *   - the proxy resolves "latest release" server-side, so the client needs no
 *     GitHub API call and the CTA has a direct href as soon as the platform
 *     is detected;
 *   - the proxy streams the installer and reports download started /
 *     completed / aborted telemetry, which a plain link click can never
 *     provide;
 *   - website downloads are separated from electron-updater traffic (the
 *     auto-updater keeps fetching from GitHub directly).
 *
 * The proxy 302s to the GitHub releases page when no matching installer is
 * published (e.g. Windows during a partial release), so these URLs are safe
 * to link unconditionally.
 *
 * Detection:
 *   - Mac arm64 / Mac x64: via `navigator.userAgentData.getHighEntropyValues`
 *     (Chromium) when available; otherwise defaults to arm64 since Apple
 *     Silicon has been the mainstream Mac since 2020. The legacy UA string
 *     always reports "Intel" on macOS regardless of chip, so it can't be
 *     relied on.
 *   - Windows arm64 / Windows x64: same high-entropy API. Windows UA also
 *     lies about arch by default.
 *   - Linux arm64 / x64: same high-entropy API; the proxy serves the AppImage
 *     (distro-agnostic — deb users can pick theirs on the releases page).
 *   - Unknown (mobile, etc.): the CTA links to the releases page where the
 *     user picks.
 */

export const DOWNLOAD_BASE_URL = 'https://download.antseed.com';
export const RELEASES_URL = 'https://github.com/AntSeed/antseed/releases/latest';
/** Full releases list — every platform, arch, and past version. */
export const ALL_VERSIONS_URL = 'https://github.com/AntSeed/antseed/releases';

export type DesktopPlatform = 'mac' | 'win' | 'linux' | 'unknown';
export type DesktopArch = 'arm64' | 'x64';

export interface DesktopDownload {
  /** Detected OS — used to pick label text. */
  platform: DesktopPlatform;
  /** Detected CPU arch. Unknown arch defaults to `arm64` for Mac, `x64` for Windows. */
  arch: DesktopArch;
  /** Direct download URL through the proxy, or `null` when the OS is unknown. */
  url: string | null;
  /**
   * URL a CTA should link to: prefers the proxy URL, falls back to the
   * releases page so users always have somewhere to go.
   */
  href: string;
  /** Human label, e.g. "Download for Mac" / "Download for Windows" / "Download". */
  label: string;
}

/** Proxy download URL for a detected platform, or null for unknown ones. */
export function downloadUrlFor(platform: DesktopPlatform, arch: DesktopArch): string | null {
  if (platform === 'unknown') return null;
  return `${DOWNLOAD_BASE_URL}/vpr/${platform}-${arch}`;
}

function detectPlatform(): DesktopPlatform {
  if (typeof navigator === 'undefined') return 'unknown';
  // Phones in "Desktop site" mode spoof a desktop UA (Samsung Internet
  // reports X11/Linux) — never resolve an installer for a device that can't
  // run one; 'unknown' falls back to the releases page.
  if (isMobileGetStartedVisitor()) return 'unknown';
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return 'win';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Linux/.test(ua) && !/Android/.test(ua)) return 'linux';
  return 'unknown';
}

function defaultArchFor(platform: DesktopPlatform): DesktopArch {
  // Apple Silicon has been the default Mac since late 2020; Windows is still
  // predominantly x64. These are the fallbacks when the high-entropy arch API
  // is unavailable (non-Chromium browsers).
  return platform === 'mac' ? 'arm64' : 'x64';
}

interface UserAgentDataLike {
  getHighEntropyValues(hints: string[]): Promise<{architecture?: string; bitness?: string}>;
}

async function detectArch(platform: DesktopPlatform): Promise<DesktopArch> {
  const fallback = defaultArchFor(platform);
  if (typeof navigator === 'undefined') return fallback;
  const nav = navigator as Navigator & {userAgentData?: UserAgentDataLike};
  if (!nav.userAgentData?.getHighEntropyValues) return fallback;
  try {
    const data = await nav.userAgentData.getHighEntropyValues(['architecture', 'bitness']);
    // Values per the UA-CH spec: "x86", "arm", "arm64", ... Bitness is "64" or "32".
    if (data.architecture === 'arm') return 'arm64';
    if (data.architecture === 'x86') return 'x64';
    return fallback;
  } catch {
    return fallback;
  }
}

function labelFor(platform: DesktopPlatform): string {
  switch (platform) {
    case 'mac':
      return 'Download for Mac';
    case 'win':
      return 'Download for Windows';
    case 'linux':
      return 'Download for Linux';
    default:
      return 'Download';
  }
}

/** Resolve a confident direct-download URL after an early CTA click. */
export async function resolveLatestDesktopDownload(): Promise<string | null> {
  const platform = detectPlatform();
  if (platform === 'unknown') return null;
  return downloadUrlFor(platform, await detectArch(platform));
}

/**
 * React hook. Returns resolved download metadata. Safe to call during SSR
 * (returns a neutral fallback that points at the releases page).
 */
export function useLatestDesktopDownload(): DesktopDownload {
  // Initial state must be deterministic and identical between server and
  // first client render — otherwise we trip React hydration mismatches
  // (#418) because the rendered label and SVG icon both depend on platform.
  // We start as 'unknown' / 'x64' (matching what SSR sees) and resolve the
  // real values inside an effect after mount.
  const [platform, setPlatform] = useState<DesktopPlatform>('unknown');
  const [arch, setArch] = useState<DesktopArch>('x64');

  useEffect(() => {
    if (!ExecutionEnvironment.canUseDOM) return;
    const p = detectPlatform();
    setPlatform(p);
    setArch(defaultArchFor(p));
    let cancelled = false;
    detectArch(p).then(a => {
      if (!cancelled) setArch(a);
    });
    return () => { cancelled = true; };
  }, []);

  const url = downloadUrlFor(platform, arch);
  return {
    platform,
    arch,
    url,
    href: url ?? RELEASES_URL,
    label: labelFor(platform),
  };
}
