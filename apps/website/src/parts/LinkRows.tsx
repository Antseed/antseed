import type {JSX, ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import styles from './LinkRows.module.css';

export type LinkRow = {
  name: string;
  href: string;
  text?: ReactNode;
  /** The link's words at the right, before the arrow. */
  action?: string;
  /** A logo (decorative). */
  mark?: ReactNode;
  /** Accessible name of the link, when the visible words are not enough. */
  label?: string;
};

type Props = {
  rows: readonly LinkRow[];
  /** Two rows side by side from 900px. */
  columns?: 1 | 2;
  className?: string;
};

/** Links as rows between dotted lines: a mark, a name and a line, and an arrow that leans forward on hover. */
export function LinkRows({rows, columns = 1, className}: Props): JSX.Element {
  return (
    <ul className={clsx(styles.rows, columns === 2 && styles.two, className)}>
      {rows.map((r) => (
        <li key={r.name} className={styles.item} data-rv="">
          <Link to={r.href} className={styles.row} aria-label={r.label}>
            {r.mark && (
              <span className={styles.mark} aria-hidden="true">
                {r.mark}
              </span>
            )}
            <span className={styles.words}>
              <b className={styles.name}>{r.name}</b>
              {r.text && <span className={styles.text}>{r.text}</span>}
            </span>
            <span className={styles.action}>{r.action && <span className={styles.actionText}>{r.action}</span>}<span className={styles.arrow} aria-hidden="true">→</span></span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
