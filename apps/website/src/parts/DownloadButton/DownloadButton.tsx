import type {JSX} from 'react';
import {Button, type ButtonSize} from '../../components/Button';
import {OS_NAMES, useDesktopDownload} from './useDesktopDownload';
import styles from './DownloadButton.module.css';

/**
 * `product`: "Download Antseed Desktop". `os`: "Download for macOS", for the visitor's system. `nav`: "Download Desktop", shortened
 * on narrow screens. On a phone the product and system labels read "Get Antseed Desktop →".
 */
export type DownloadLabel = 'product' | 'os' | 'nav';

const PHONE_LABEL = 'Get Antseed Desktop →';

type Props = {label?: DownloadLabel; size?: ButtonSize; className?: string};

/** Antseed Desktop's download for this computer; on a phone, the /get-started flow. A plain link to the installer, so the site's
 *  download tracking (src/theme/Root.tsx) recognises it by its URL. */
export function DownloadButton({label = 'product', size, className}: Props): JSX.Element {
  const download = useDesktopDownload();
  return (
    <Button href={download.href} size={size} className={className} onClick={download.onClick}>
      {label === 'nav' ? (
        <>
          <span className={styles.long}>Download Desktop</span>
          <span className={styles.short}>Download</span>
        </>
      ) : download.phone ? PHONE_LABEL
        : label === 'os' ? (download.os ? `Download for ${OS_NAMES[download.os]}` : 'Download')
        : 'Download Antseed Desktop'}
    </Button>
  );
}
