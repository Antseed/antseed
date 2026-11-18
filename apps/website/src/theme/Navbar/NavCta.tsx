import type {JSX} from 'react';
import clsx from 'clsx';
import {DownloadButton} from '@site/src/parts/DownloadButton/DownloadButton';
import NavLink from './NavLink';
import {GATEWAY} from './links';
import styles from './NavCta.module.css';

/** The nav's secondary action. In the bar it only shows on wide screens. */
export function GatewayCta({className}: {className?: string}): JSX.Element {
  return <NavLink item={GATEWAY} className={clsx(styles.gateway, className)} />;
}

/** The main action: Antseed Desktop for the visitor's system. */
export function DownloadCta({className}: {className?: string}): JSX.Element {
  return <DownloadButton label="nav" size="small" className={clsx(styles.download, className)} />;
}
