import type {JSX, ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import {Eyebrow} from '../components';
import styles from './EyebrowLink.module.css';

type Props = {to: string; className?: string; children: ReactNode};

/** A section's eyebrow as a link, with a chevron that leans forward on hover. */
export function EyebrowLink({to, className, children}: Props): JSX.Element {
  return (
    <Eyebrow className={className}>
      <Link className={styles.link} to={to} data-rv="">{children}&nbsp;<span className={styles.chevron} aria-hidden="true">›</span></Link>
    </Eyebrow>
  );
}
