import type {CSSProperties, JSX} from 'react';
import clsx from 'clsx';
import styles from './CopyMark.module.css';

/** A copy button's mark in `currentColor`, a green tick once copied. Decorative. */
export function CopyMark({done, size, className}: {done: boolean; size: number; className?: string}): JSX.Element {
  return <span className={clsx(styles.mark, done && styles.done, className)} style={{'--mark-size': `${size}px`} as CSSProperties} aria-hidden="true" />;
}
