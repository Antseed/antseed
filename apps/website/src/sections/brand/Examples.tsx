import type {JSX} from 'react';
import clsx from 'clsx';
import {Section} from '../../components';
import {Bar, Head, kit} from './Kit';
import {ANT_EXAMPLES, ANT_EXAMPLES_ZIP} from './assets';
import styles from './Examples.module.css';

/** The ants at work: a mosaic ruled in dots, each one a download. */
export default function Examples(): JSX.Element {
  return (
    <Section cmp="brand/examples" id="examples" labelledBy="examples-title" railClassName={kit.rail}>
      <Head eyebrow="Examples" id="examples-title" title={['A costume,', 'for every job.']} />
      <div className={styles.mosaic}>
        {ANT_EXAMPLES.map((a) => (
          <a key={a.slug} className={clsx(kit.cell, kit.lineTop, styles.tile)} href={a.src} download aria-label={`Download the ant with ${a.thing}`}>
            <img src={a.src} alt="" loading="lazy" decoding="async" />
          </a>
        ))}
      </div>
      <Bar files={[{label: 'ZIP', href: ANT_EXAMPLES_ZIP}]} />
    </Section>
  );
}
