import React from 'react';
import DefaultNavbarItem, {type Props as DefaultNavbarItemProps} from '@theme/NavbarItem/DefaultNavbarItem';
import {useLatestDesktopDownload} from '@site/src/lib/useLatestDesktopDownload';

/**
 * Navbar "Download the AI VPN" item (`type: 'custom-download'` in docusaurus.config).
 * Same rendering as a plain link navbar item, but the href is resolved at
 * runtime to the direct installer for the visitor's OS/arch, falling back to
 * the releases page when no installer matches (Linux, unknown platforms, or
 * before the release lookup resolves).
 *
 * In the mobile sidebar (hamburger menu) the item becomes "Get the AI VPN"
 * linking to the /get-started Telegram flow instead — phones and tablets
 * can't run the desktop installer, so a download link is a dead end there.
 */
export default function DownloadNavbarItem(
  props: Omit<DefaultNavbarItemProps, 'href' | 'to'>,
): React.ReactNode {
  const {href} = useLatestDesktopDownload();
  if (props.mobile) {
    return <DefaultNavbarItem {...props} label="Get the AI VPN" to="/get-started" />;
  }
  return <DefaultNavbarItem {...props} href={href} />;
}
