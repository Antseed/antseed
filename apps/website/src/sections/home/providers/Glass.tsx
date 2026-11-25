import type {JSX} from 'react';
import {Glass, GlassLayer} from '../../../parts/Glass/Glass';
import {GlassCard} from '../../../parts/Glass/GlassCard';
import {LISTING} from './paths';
import styles from './Glass.module.css';

/** The own provider's listing, to the right of the stall. */
export function ListingCard(): JSX.Element {
  return (
    <GlassCard
      title="Your provider"
      rows={LISTING}
      className={styles.listing}
      footer={<p className={styles.flow}><span>Request received</span><i>→</i><span>serve</span><i>→</i><span>settle</span></p>}
    />
  );
}

/** The colony's caption over its three Macs, on the same glass. */
export function ColonyLabel(): JSX.Element {
  return (
    <GlassLayer>
      <Glass className={styles.label}>
        <p className={styles.labelTitle}>Many Macs. One provider.</p>
        <p className={styles.labelSub}>Shared capacity · operator-managed routing</p>
      </Glass>
    </GlassLayer>
  );
}
