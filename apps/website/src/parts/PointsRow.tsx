import {useRef, type JSX, type ReactNode} from 'react';
import clsx from 'clsx';
import {usePlayOnView} from '../lib/usePlayOnView';
import styles from './PointsRow.module.css';

type RowProps = {
  className?: string;
  /** The points' content fades up into place, one after another, the first time the row is seen. */
  rise?: boolean;
  children: ReactNode;
};

/** A row of points between dotted lines, the rail's width: three across by default, one per line on phones. */
export function PointsRow({className, rise, children}: RowProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const pending = usePlayOnView(ref);
  return <div ref={ref} className={clsx(styles.row, rise && styles.rise, rise && pending && styles.pending, className)}>{children}</div>;
}

/** One cell of a PointsRow; its content centred unless the row says otherwise. */
export function Point({className, children}: {className?: string; children: ReactNode}): JSX.Element {
  return <div className={clsx(styles.point, className)}>{children}</div>;
}

/** A point's caption: its name in ink, then the line. */
export function PointCaption({name, children, className}: {name: string; children: ReactNode; className?: string}): JSX.Element {
  return <p className={clsx(styles.caption, className)}><b>{name}</b> {children}</p>;
}
