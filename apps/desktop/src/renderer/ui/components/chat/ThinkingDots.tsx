import styles from './ThinkingDots.module.scss';

/** A request is on its way and no tokens have arrived yet. */
export function ThinkingDots({ label }: { label?: string | null }) {
  return (
    <p className={styles.thinking} role="status">
      <span className={styles.dots} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {label ?? 'Thinking…'}
    </p>
  );
}
