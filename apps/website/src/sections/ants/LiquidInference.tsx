import type {JSX} from 'react';
import {Button, Duo, Eyebrow, Heading, Sub, Wash} from '../../components';
import styles from './PointSection.module.css';

const ART = '/site/assets/home/ants/inference-pass';

export function LiquidInference(): JSX.Element {
  return (
    <Duo cmp="ants/liquid-inference" id="liquid-inference" labelledBy="liquid-inference-title"
      className={styles.section} railClassName={styles.rail} textClassName={styles.text}
      panel={<Wash unveil reveal="panel" className={styles.panel} day={`${ART}-day.webp`} night={`${ART}-night.webp`}
        label="An ant in a lime neckerchief holds a green pass as seed-stamped tickets curl out of a wooden dispenser." />}
      text={<>
        <Heading id="liquid-inference-title" strong reveal secondLine="break" title={['ANTS as', 'liquid inference.']} />
        <section className={styles.offer} data-rv="">
          <h3>Free AI</h3>
          <Sub>Stake ANTS behind a participating provider to get free AI requests. Each provider sets its own models, stake requirements and request limits.</Sub>
          <Button href="https://antseedstats.com/staking/free" size="page">Compare free AI offers ↗</Button>
        </section>
        <section className={styles.offer} data-rv="">
          <Eyebrow>Coming soon</Eyebrow>
          <h3>Weekly inference credits</h3>
          <Sub>You’ll be able to lock your lANTS NFT in a pool and receive inference credits each week.</Sub>
        </section>
      </>} />
  );
}
