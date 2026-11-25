import type {JSX} from 'react';
import {Wash} from '../../components';
import {Glass} from '../../parts/Glass/Glass';
import {pictureClass} from './ListingCard';
import styles from './YourProjectPanel.module.css';
import {PAINTINGS} from '../../lib/paintings';

const KINDS = ['App', 'Explorer', 'Provider', 'Agent', 'Router', 'Managed product'] as const;

/** The directory's last card: an empty listing for the visitor's own project, a glass window on a painting. Decorative. */
export default function YourProjectPanel(): JSX.Element {
  return (
    <Wash unveil className={pictureClass} {...PAINTINGS.ferns}>
      <Glass decorative className={styles.window}>
        <p className={styles.top}><b>Your project</b><span className={styles.add}>Add it</span></p>
        <p className={styles.kinds}>{KINDS.map((k) => <span key={k} className={styles.kind}>{k}</span>)}</p>
      </Glass>
    </Wash>
  );
}

