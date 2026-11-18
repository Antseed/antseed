import type {JSX, MouseEvent, RefObject} from 'react';
import {OS_NAMES} from '../../../../parts/DownloadButton/useDesktopDownload';
import {BUILDS, OLDER_BUILDS} from '../data';
import {OsIcon} from './OsIcon';
import styles from './InstallPanel.module.css';

type Props = {dialogRef: RefObject<HTMLDialogElement | null>; detected: string | null};

const DOWNLOAD_BASE = 'https://download.antseed.com/vpr';

/** Every Desktop build, a click away; the one for this computer marked. Closes on its button, Escape or a click on the backdrop. */
export function VersionsDialog({dialogRef, detected}: Props): JSX.Element {
  const close = () => dialogRef.current?.close();
  const onBackdrop = (e: MouseEvent<HTMLDialogElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if (e.target === e.currentTarget && outside) close();
  };
  return (
    <dialog ref={dialogRef} className={styles.versions} aria-label="All download versions" onClick={onBackdrop}>
      <header className={styles.versionsHead}>Download Antseed Desktop<button type="button" className={styles.close} aria-label="Close" onClick={close}>×</button></header>
      {BUILDS.map((b) => (
        <a key={b.id} className={styles.build} href={`${DOWNLOAD_BASE}/${b.id}`}>
          <OsIcon os={b.os} />
          <span><b>{OS_NAMES[b.os]}</b><small>{b.detail}</small></span>
          {b.id === detected && <i>Detected</i>}
        </a>
      ))}
      <a className={styles.older} href={OLDER_BUILDS} target="_blank" rel="noopener noreferrer">Older versions &amp; .deb packages →</a>
    </dialog>
  );
}
