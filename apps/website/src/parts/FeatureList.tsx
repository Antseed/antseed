import type {JSX, ReactNode} from 'react';
import clsx from 'clsx';
import {PixelIcon, type PixelIconName} from './PixelIcon';
import styles from './FeatureList.module.css';

export type Feature = {
  icon: PixelIconName;
  /** A string, or lines with authored breaks (kept together as one flex item). */
  text: ReactNode;
};

type Props = {
  items: readonly Feature[];
  /** The icon centred on its text, or on its first line (points that wrap). Phones always take the first line. */
  align?: 'center' | 'first-line';
  className?: string;
  itemClassName?: string;
};

/** A product's features: one line each, a pixel icon centred on its text. */
export function FeatureList({items, align = 'center', className, itemClassName}: Props): JSX.Element {
  return (
    <ul className={clsx(styles.list, align === 'first-line' && styles.firstLine, className)}>
      {items.map(({icon, text}, i) => (
        <li key={i} className={clsx(styles.item, itemClassName)} data-rv="">
          <PixelIcon name={icon} className={styles.icon} />
          {typeof text === 'string' ? text : <span>{text}</span>}
        </li>
      ))}
    </ul>
  );
}
