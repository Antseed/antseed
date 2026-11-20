import {useRef, type CSSProperties, type JSX, type ReactNode} from 'react';
import clsx from 'clsx';
import {Wash} from '../../../components';
import {usePlayOnView} from '../../../lib/usePlayOnView';
import styles from './PathCard.module.css';
import type {Painting} from '../../../lib/paintings';

const SEEN_SHARE = 0.2;

type Props = {
  title: string;
  text: string;
  painting: Painting;
  /** Its place in the row: side by side, each comes in a beat after the one before. */
  index: number;
  children: ReactNode;
};

/** One way of running a provider: a painting with its product screen, a title and a line under it. */
export function PathCard({title, text, painting, index, children}: Props): JSX.Element {
  const ref = useRef<HTMLElement>(null);
  const pending = usePlayOnView(ref, SEEN_SHARE);
  return (
    <article ref={ref} className={clsx(styles.card, pending && styles.pending)} style={{'--card-index': index} as CSSProperties}>
      <Wash unveil className={styles.panel} {...painting}>{children}</Wash>
      <h3 className={styles.title}>{title}</h3>
      <p className={styles.text}>{text}</p>
    </article>
  );
}
