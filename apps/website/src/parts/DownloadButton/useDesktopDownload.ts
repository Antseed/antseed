import {useEffect, useState, type MouseEvent} from 'react';
import {RELEASES_URL, useLatestDesktopDownload} from '../../lib/useLatestDesktopDownload';
import {isMobileGetStartedVisitor, useMobileGetStarted} from '../../lib/useMobileGetStarted';

export type Os = 'mac' | 'win' | 'linux';
export const OS_NAMES: Record<Os, string> = {mac: 'macOS', win: 'Windows', linux: 'Linux'};

export type DesktopDownload = {
  /** The installer for this computer; the releases page on a phone and until the system is known. */
  href: string;
  /** The computer's system (macOS until it is known, on the server too); null on a phone. */
  os: Os | null;
  /** The build id ("mac-arm64") once detected. */
  detected: string | null;
  /** A phone or tablet: the link leads to /get-started instead. */
  phone: boolean;
  /** Sends phones to /get-started instead of downloading an installer they can't run. */
  onClick: (e: MouseEvent<HTMLAnchorElement>) => void;
};

/** The Antseed Desktop download for the visitor's system. Renders as macOS on the server, then follows the visitor once mounted. */
export function useDesktopDownload(): DesktopDownload {
  const download = useLatestDesktopDownload();
  const onClick = useMobileGetStarted();
  const [phone, setPhone] = useState<boolean | null>(null);
  useEffect(() => setPhone(isMobileGetStartedVisitor()), []);
  if (phone === null) return {href: RELEASES_URL, os: 'mac', detected: null, phone: false, onClick};
  if (download.platform === 'unknown') return {href: RELEASES_URL, os: null, detected: null, phone, onClick};
  return {href: download.href, os: download.platform, detected: `${download.platform}-${download.arch}`, phone, onClick};
}
