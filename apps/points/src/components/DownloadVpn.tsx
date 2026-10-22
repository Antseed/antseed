import { useMemo } from 'react';

// Same proxy the website's download buttons use (apps/website/src/lib/useLatestDesktopDownload.ts).
const DOWNLOAD_BASE_URL = 'https://download.antseed.com';
/** Phones and unknown systems go to the website, which explains how to get started. */
const FALLBACK_URL = 'https://antseed.com';

type Platform = 'mac' | 'win' | 'linux' | 'unknown';

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod/.test(ua)) return 'unknown';
  if (/Windows/.test(ua)) return 'win';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Linux/.test(ua)) return 'linux';
  return 'unknown';
}

/** The direct AI VPN download for this visitor's system (Apple silicon assumed on Mac, as on the website). */
export function useVpnDownload() {
  return useMemo(() => {
    const platform = detectPlatform();
    if (platform === 'unknown') return { href: FALLBACK_URL, external: true };
    const arch = platform === 'mac' ? 'arm64' : 'x64';
    return { href: `${DOWNLOAD_BASE_URL}/vpr/${platform}-${arch}`, external: false };
  }, []);
}

export function DownloadVpnButton({ className = 'btn btn-ink', style, label = 'Download the AI VPN', phoneLabel = 'Get the AI VPN for your computer' }: { className?: string; style?: React.CSSProperties; label?: string; phoneLabel?: string }) {
  const d = useVpnDownload();
  return (
    <a className={className} href={d.href} style={style} {...(d.external ? { target: '_blank', rel: 'noreferrer' } : {})}>
      {/* On a phone there's nothing to download here: say where it goes. */}
      {d.external ? phoneLabel : label}
    </a>
  );
}
