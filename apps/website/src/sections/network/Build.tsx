import type {JSX} from 'react';
import {Intro} from '../../components';
import styles from './Build.module.css';

/** What we're building, and the two reasons, each named in ink. */
export default function Build(): JSX.Element {
  return (
    <Intro
      cmp="network/build"
      label="What we’re building"
      eyebrow="What we’re building"
      lede="The world’s largest inference liquidity network."
      pretty
      balanceLast
      more={[
        <><span className={styles.ink}>Why it matters.</span> Intelligence can be produced anywhere, so its market should be open to everyone. Anyone can supply inference directly to buyers, on their own terms.</>,
        <><span className={styles.ink}>Where ANTS fits.</span> Inference is the currency of intelligence. ANTS makes it liquid.</>,
      ]}
    />
  );
}
