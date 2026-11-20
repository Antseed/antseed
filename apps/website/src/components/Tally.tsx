import {useRef, useState, type JSX} from 'react';
import clsx from 'clsx';
import {useCountUp} from '../lib/useCountUp';
import styles from './Tally.module.css';

/** A figure ("19,252", "742.8B") that counts up the first time it is seen, and takes live values as they arrive (the server value
 *  renders first). */
export function Tally({value, className}: {value: string; className?: string}): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  // later values are written by useCountUp, so React never fights the count over the text
  const [initial] = useState(value);
  useCountUp(ref, value);
  return (
    <span className={clsx(styles.tally, className)}>
      <span className={styles.holder} aria-hidden="true">{value}</span>
      <span ref={ref}>{initial}</span>
    </span>
  );
}
