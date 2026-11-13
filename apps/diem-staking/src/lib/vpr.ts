// Smart VPR download URL — mirrors the hook at
// `apps/website/src/lib/useLatestDesktopDownload.ts` so the "Download
// VPR" links on diemantseed.com behave exactly like the ones on
// antseed.com: when the visitor is on a Mac or Windows machine, resolve a
// direct installer URL matching their CPU arch from the real release asset
// list. On other platforms — or while the GitHub API lookup is in-flight —
// fall back to the releases page.
//
// This file and the docusaurus hook duplicate a small amount of logic on
// purpose: they live in different frameworks (Vite SPA with react-query
// here vs. Docusaurus SSR there), and extracting a shared package would
// cost more than the dup is worth. If you change the asset-matching rules
// in one, update the other.
//
// Asset matching is done by regex against `asset.name` rather than URL
// construction so we self-correct when electron-builder shifts its
// artifact naming between releases.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

export const VPR_RELEASES_URL = 'https://github.com/Antseed/antseed/releases/latest';
const GH_API_LATEST = 'https://api.github.com/repos/Antseed/antseed/releases/latest';

export type Platform = 'mac' | 'win' | 'linux' | 'unknown';
export type Arch = 'arm64' | 'x64';

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}
interface GitHubRelease {
  tag_name?: string;
  assets?: GitHubAsset[];
}

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

function matchAsset(assets: GitHubAsset[], platform: Platform, arch: Arch): GitHubAsset | null {
  const isBlockmap = (n: string) => /\.blockmap$/i.test(n);
  const hasArm64 = (n: string) => /arm64/i.test(n);

  if (platform === 'mac') {
    return (
      assets.find((a) => {
        if (isBlockmap(a.name)) return false;
        if (!/\.dmg$/i.test(a.name)) return false;
        return arch === 'arm64' ? hasArm64(a.name) : !hasArm64(a.name);
      }) ?? null
    );
  }
  if (platform === 'win') {
    return (
      assets.find((a) => {
        if (isBlockmap(a.name)) return false;
        if (!/\.exe$/i.test(a.name)) return false;
        return arch === 'arm64' ? hasArm64(a.name) : !hasArm64(a.name);
      }) ?? null
    );
  }
  return null;
}

export interface VprDownload {
  /** URL to put on the `href`. Direct installer when resolvable, releases page otherwise. */
  href: string;
  /** True when the resolved href points at a direct installer (click = real download). */
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
 *
 * Uses react-query so multiple call-sites share a single cached GitHub API
 * response (the QueryClient is already set up in `main.tsx`).
 */
export function useVprDownload(): VprDownload {
  const platform = useMemo<Platform>(detectPlatform, []);
  const arch = useArch(platform);

  const { data: release } = useQuery<GitHubRelease | null>({
    queryKey: ['vpr-latest-release'],
    // GitHub releases change on a ~weekly cadence at most; an hour of
    // staleness is plenty and keeps us well under the unauthenticated API
    // rate limit (60/hr per IP) even if the user opens many tabs.
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    // Skip the fetch on platforms we don't ship installers for — Linux /
    // unknown visitors go straight to the releases page.
    enabled: platform === 'mac' || platform === 'win',
    retry: 1,
    queryFn: async (): Promise<GitHubRelease | null> => {
      const r = await fetch(GH_API_LATEST);
      if (!r.ok) return null;
      return ((await r.json()) as GitHubRelease) ?? null;
    },
  });

  const matched = useMemo(() => {
    const assets = release?.assets;
    if (!assets || assets.length === 0) return null;
    return matchAsset(assets, platform, arch);
  }, [release, platform, arch]);

  const href = matched?.browser_download_url ?? VPR_RELEASES_URL;
  return {
    href,
    isDirectDownload: !!matched,
    platform,
    label: labelFor(platform),
  };
}
