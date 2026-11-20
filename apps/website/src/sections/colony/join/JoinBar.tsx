import type {JSX} from 'react';
import Link from '@docusaurus/Link';
import styles from './JoinPage.module.css';

/** The waitlist pages' top bar: the logo, the progress line with its count, and the way back to /colony/. */
export function JoinBar({progress, count, live}: {progress: number; count: string; live?: boolean}): JSX.Element {
  return (
    <header className={styles.bar}>
      <Link className={styles.logo} to="/colony/" aria-label="Antseed Colony"><img src="/site/assets/hero/logo.svg" width={95} height={33} alt="Antseed" /></Link>
      <div className={styles.progress} aria-hidden="true"><i className={styles.progressFill} style={{width: `${progress}%`}} /></div>
      <p className={styles.count} aria-live={live ? 'polite' : undefined}>{count}</p>
      <Link className={styles.close} to="/colony/" aria-label="Close and go back to Colony">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </Link>
    </header>
  );
}
