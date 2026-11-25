import type {JSX, ReactNode} from 'react';
import {Eyebrow} from '../../../components';
import styles from './Guide.module.css';

type Props = {id?: string; eyebrow: string; title: string; children: ReactNode};

/** One part of a guide: a green label, its title, then the content, under a dotted line. */
export function GuideSection({id, eyebrow, title, children}: Props): JSX.Element {
  const titleId = id ? `${id}-title` : undefined;
  return (
    <section id={id} className={styles.part} aria-labelledby={titleId}>
      <header className={styles.partHead} data-rv="">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 id={titleId} className={styles.partTitle}>{title}</h2>
      </header>
      <div className={styles.partBody}>{children}</div>
    </section>
  );
}
