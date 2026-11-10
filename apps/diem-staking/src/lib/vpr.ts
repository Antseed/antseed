// Smart VPR download URL — mirrors the hook at
// `apps/website/src/lib/useLatestDesktopDownload.ts` so the "Download
// VPR" links on diemantseed.com behave exactly like the ones on
// antseed.com: when the visitor is on a Mac, Windows or Linux machine, link
// the download proxy (download.antseed.com, see apps/download-proxy) for
// their OS and CPU arch. The proxy resolves the latest release server-side,
// streams the installer, and redirects to the releases page when no
// matching installer is published. On other platforms, link the releases
// page.
//
// This file and the docusaurus hook duplicate a small amount of logic on
// purpose: they live in different frameworks (Vite SPA here vs. Docusaurus
// SSR there), and extracting a shared package would cost more than the dup
// is worth. If you change the platform or arch rules in one, update the
// other.
import { useEffect, useMemo, useState } from 'react';

export const VPR_RELEASES_URL = 'https://github.com/Antseed/antseed/releases/latest';
const DOWNLOAD_BASE_URL = 'https://download.antseed.com';

export type Platform = 'mac' | 'win' | 'linux' | 'unknown';
export type Arch = 'arm64' | 'x64';

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return 'win';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Linux/.test(ua) && !/Android/.test(ua)) return 'linux';
  return 'unknown';
}

function defaultArchFor(platform: Platform): Arch {
  // Apple Silicon has been the default Mac since late 2020; Windows is
  // still predominantly x64. These kick in when the Chromium high-entropy
  // arch API isn't available (Safari, Firefox, older browsers).
  return platform === 'mac' ? 'arm64' : 'x64';
}

interface UserAgentDataLike {
  getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }>;
}

/** Resolve CPU architecture via the Chromium UserAgentData API. The legacy
 *  UA string always says "Intel" on macOS regardless of chip, so we need
 *  the high-entropy hint. Same story on Windows for arm64. Silently keeps
 *  the platform-appropriate default if the API is absent or rejects. */
function useArch(platform: Platform): Arch {
  const [arch, setArch] = useState<Arch>(() => defaultArchFor(platform));
  useEffect(() => {
    const nav = navigator as Navigator & { userAgentData?: UserAgentDataLike };
    if (!nav.userAgentData?.getHighEntropyValues) return;
    let cancelled = false;
    nav.userAgentData
      .getHighEntropyValues(['architecture'])
      .then((d) => {
        if (cancelled) return;
        if (d.architecture === 'arm') setArch('arm64');
        else if (d.architecture === 'x86') setArch('x64');
      })
      .catch(() => {
        /* keep default */
      });
    return () => {
      cancelled = true;
    };
  }, [platform]);
  return arch;
}

/** Download proxy URL for a detected platform, or null for unknown ones. */
export function vprDownloadUrlFor(platform: Platform, arch: Arch): string | null {
  if (platform === 'unknown') return null;
  return `${DOWNLOAD_BASE_URL}/vpr/${platform}-${arch}`;
}

export interface VprDownload {
  /** URL to put on the `href`. Download proxy URL when the OS is known, releases page otherwise. */
  href: string;
  /** True when the href points at the download proxy (click = real download). */
  isDirectDownload: boolean;
  /** Detected OS — used by call-sites to swap icon + button label. */
  platform: Platform;
  /** OS-specific CTA label: "Download for Mac" / "Download for Windows" /
   *  "Download for Linux" / "Download". Call-sites that use a branded
   *  "Download VPR →" label are free to ignore this. */
  label: string;
}

function labelFor(platform: Platform): string {
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

/**
 * Returns the best VPR download target for the current visitor.
 * All call-sites on this page should use this in place of hardcoding
 * `VPR_RELEASES_URL` so the primary CTA always downloads the right
 * installer and gracefully falls back on unsupported platforms.
 */
export function useVprDownload(): VprDownload {
  const platform = useMemo<Platform>(detectPlatform, []);
  const arch = useArch(platform);
  const url = vprDownloadUrlFor(platform, arch);
  return {
    href: url ?? VPR_RELEASES_URL,
    isDirectDownload: url !== null,
    platform,
    label: labelFor(platform),
  };
}
