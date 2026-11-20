import type {JSX} from 'react';
import {SOCIAL_LINKS} from './links';
import styles from './Footer.module.css';

export default function SocialLinks(): JSX.Element {
  return (
    <div className={styles.social}>
      {SOCIAL_LINKS.map((s) => (
        <a key={s.href} className={styles.socialLink} href={s.href} target="_blank" rel="noopener noreferrer" aria-label={s.label}>
          <svg viewBox={s.viewBox} aria-hidden="true"><path d={s.path} /></svg>
        </a>
      ))}
    </div>
  );
}
