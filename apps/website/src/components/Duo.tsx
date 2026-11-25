import type {JSX, ReactNode} from 'react';
import clsx from 'clsx';
import {Section} from './Section';
import styles from './Duo.module.css';

type Props = {
  cmp: string;
  id?: string;
  label?: string;
  labelledBy?: string;
  /** Panel on the left on wide screens; text still comes first on phones. */
  flip?: boolean;
  /** The text column (use DuoHead for the title block). */
  text: ReactNode;
  panel: ReactNode;
  /** Section's grid snap. */
  snap?: boolean | 'narrow';
  className?: string;
  railClassName?: string;
  textClassName?: string;
};

/** Half text, half a panel. */
export function Duo({cmp, id, label, labelledBy, flip, text, panel, snap, className, railClassName, textClassName}: Props): JSX.Element {
  const textCol = <div className={clsx(styles.text, textClassName)}>{text}</div>;
  return (
    <Section cmp={cmp} id={id} label={label} labelledBy={labelledBy} snap={snap} className={clsx(flip && styles.flip, className)} railClassName={clsx(styles.rail, railClassName)}>
      {flip ? <>{panel}{textCol}</> : <>{textCol}{panel}</>}
    </Section>
  );
}

/** The title block inside a Duo's text column. */
export function DuoHead({children, className}: {children: ReactNode; className?: string}): JSX.Element {
  return <div className={clsx(styles.head, className)}>{children}</div>;
}
