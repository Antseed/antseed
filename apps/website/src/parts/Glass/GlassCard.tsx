import type {JSX, ReactNode} from 'react';
import clsx from 'clsx';
import {Glass, GlassLayer} from './Glass';
import styles from './GlassCard.module.css';

export type GlassCardRow = {term: string; value: string};

type Props = {
  title: string;
  rows: readonly GlassCardRow[];
  /** In the middle of the painting; otherwise centred vertically only. */
  center?: boolean;
  /** Places the card on its painting (left or right, width). */
  className?: string;
  /** Under the rows (a flow line). */
  footer?: ReactNode;
  label?: string;
};

/** A provider's record on glass over a painting: a title with a green dot, then term and value rows; tighter on narrow panels. Put it
 *  inside the painting. */
export function GlassCard({title, rows, center, className, footer, label}: Props): JSX.Element {
  return (
    <GlassLayer label={label}>
      <Glass className={clsx(styles.card, center && styles.center, className)}>
        <p className={styles.title}><i className={styles.dot} />{title}</p>
        <dl>
          {rows.map(({term, value}) => (
            <div key={term} className={styles.row}><dt className={styles.term}>{term}</dt><dd className={styles.value}>{value}</dd></div>
          ))}
        </dl>
        {footer}
      </Glass>
    </GlassLayer>
  );
}
