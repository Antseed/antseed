import {useCallback, useEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {DesktopDownloadIcon} from './DesktopDownloadIcon';
import {LinuxIcon} from '../components/ui';
import {
  ALL_VERSIONS_URL,
  DOWNLOAD_BASE_URL,
  useLatestDesktopDownload,
  type DesktopPlatform,
} from './useLatestDesktopDownload';

/**
 * "All platforms & versions" — an escape hatch under the download CTAs for
 * visitors whose platform detection guessed wrong (privacy browsers spoof a
 * Windows UA on Linux, so the CTA offers the .exe) or who want a different
 * installer. Opens a modal listing every installer as download.antseed.com
 * links, so these downloads carry the same started/completed telemetry as
 * the main CTA.
 *
 * The list is hardcoded: the proxy always resolves /vpr/<target> to the
 * latest release server-side, so the links never go stale, and a target
 * missing from a partial release 302s to the GitHub releases page rather
 * than 404ing. Older versions and .deb packages stay on the GitHub releases
 * page, linked in the modal footer. Hidden on phone viewports, where the
 * CTAs become "Get Started".
 */

interface TargetRow {
  target: string;
  platform: DesktopPlatform;
  label: string;
  sub: string;
}

const TARGET_ROWS: TargetRow[] = [
  {target: 'mac-arm64', platform: 'mac', label: 'macOS', sub: 'Apple Silicon'},
  {target: 'mac-x64', platform: 'mac', label: 'macOS', sub: 'Intel'},
  {target: 'win-x64', platform: 'win', label: 'Windows', sub: 'x64 installer'},
  {target: 'linux-x64', platform: 'linux', label: 'Linux', sub: 'AppImage · x86_64'},
  {target: 'linux-arm64', platform: 'linux', label: 'Linux', sub: 'AppImage · ARM64'},
];

function AllVersionsModal({onClose}: {onClose: () => void}) {
  // Badge the row matching the visitor's detected OS/arch — the same
  // detection the main CTA uses, so a wrong guess (UA-spoofing privacy
  // browser) is visible at a glance and explains what the button would do.
  const {platform, arch} = useLatestDesktopDownload();
  const detectedTarget = platform === 'unknown' ? null : `${platform}-${arch}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Lock scrolling on the root element, not <body>: body is sized to the
    // viewport, so `overflow: hidden` there collapses the document and jumps
    // the page to the top. The root keeps its height and scroll position.
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      root.style.overflow = previousOverflow;
    };
  }, [onClose]);

  // Portal to <body>: the CTA blocks sit inside Reveal wrappers whose
  // `will-change: transform` makes them the containing block for
  // position:fixed descendants — rendered in place, the overlay anchors to
  // the wrong box and the card lands off-screen. Only mounted after a click,
  // so document.body is always available (no SSR concern).
  return createPortal(
    <div className="vprVersionsOverlay" onClick={onClose} role="presentation">
      <div
        className="vprVersionsModal"
        role="dialog"
        aria-modal="true"
        aria-label="All download versions"
        onClick={e => e.stopPropagation()}
      >
        <div className="vprVersionsHead">
          <span className="vprVersionsTitle">Download Antseed AI VPN</span>
          <button className="vprVersionsClose" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="vprVersionsList">
          {TARGET_ROWS.map(row => (
            <a
              key={row.target}
              className="vprVersionsRow"
              href={`${DOWNLOAD_BASE_URL}/vpr/${row.target}`}
            >
              <span className="vprVersionsIcon">
                {/* DesktopDownloadIcon has no Tux — reuse the CTA button's. */}
                {row.platform === 'linux' ? (
                  <LinuxIcon />
                ) : (
                  <DesktopDownloadIcon platform={row.platform} size={20} />
                )}
              </span>
              <span className="vprVersionsName">
                {row.label}
                <span className="vprVersionsSub">{row.sub}</span>
              </span>
              {row.target === detectedTarget && (
                <span className="vprVersionsDetected">Detected</span>
              )}
            </a>
          ))}
        </div>
        <a
          className="vprVersionsFooter"
          href={ALL_VERSIONS_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Older versions &amp; .deb packages →
        </a>
      </div>
    </div>,
    document.body,
  );
}

export function AllVersionsLink({light}: {light?: boolean}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        type="button"
        className={`vprAllVersions${light ? ' vprAllVersionsLight' : ''}`}
        onClick={() => setOpen(true)}
      >
        All platforms &amp; versions
      </button>
      {open && <AllVersionsModal onClose={close} />}
    </>
  );
}
