import type {JSX, ReactNode} from 'react';
import {Section, SectionHead} from '../components';
import styles from './HeadBeside.module.css';

type Props = {
  cmp: string;
  id?: string;
  titleId: string;
  title: string;
  sub: string;
  children: ReactNode;
};

/** A section's title and sub line on the left, its content (a list of links) on the right; one above the other below 1200px. */
export function HeadBeside({cmp, id, titleId, title, sub, children}: Props): JSX.Element {
  return (
    <Section cmp={cmp} id={id} labelledBy={titleId} pad="all" railClassName={styles.rail}>
      <SectionHead id={titleId} title={title} sub={sub} size="compact" className={styles.head} />
      <div>{children}</div>
    </Section>
  );
}
