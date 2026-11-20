import type {JSX} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import styles from './Logo.module.css';

const LOGO_WIDTH = 95.3464;
const LOGO_HEIGHT = 33;

export default function Logo({className, onClick}: {className?: string; onClick?: () => void}): JSX.Element {
  return (
    <Link to="/" aria-label="Antseed" className={clsx(styles.logo, className)} onClick={onClick}>
      <img className={styles.image} src="/site/assets/hero/logo.svg" width={LOGO_WIDTH} height={LOGO_HEIGHT} alt="Antseed" />
    </Link>
  );
}
