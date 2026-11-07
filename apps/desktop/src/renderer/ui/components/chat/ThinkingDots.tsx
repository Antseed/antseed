import { useEffect, useState } from 'react';
import styles from './ThinkingDots.module.scss';

/** Long enough that a working seller has usually started answering. */
const SLOW_AFTER_MS = 30_000;

/** A request is on its way and no tokens have arrived yet. */
export function ThinkingDots({ label }: { label?: string | null }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <p className={styles.thinking} role="status">
      <span className={styles.dots} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {slow ? 'Still waiting on this provider. You can stop and try another model.' : (label ?? 'Thinking…')}
    </p>
  );
}
