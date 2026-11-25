import type {JSX, ReactNode} from 'react';
import Link from '@docusaurus/Link';
import {Duo, DuoHead, Heading, Sub, Wash} from '../../components';
import {FeatureList, type Feature} from '../../parts/FeatureList';
import {ScoreWindow} from './ScoreWindow';
import styles from './Trust.module.css';
import {PAINTINGS} from '../../lib/paintings';

/** Each signal's lines kept even. */
const signal = (text: ReactNode) => <span className={styles.signal}>{text}</span>;

const SIGNALS: readonly Feature[] = [
  {icon: 'analytics', text: signal(<><b>History</b> Completed channels and settled USDC volume.</>)},
  {icon: 'check', text: signal(<><b>Model audits</b> Knowledge Boundary Fingerprinting compares answers with the genuine model. Evidence is public.</>)},
  {icon: 'lock', text: signal(<><b>Backing</b> ANTS locked behind the provider’s identity.</>)},
  {icon: 'user', text: signal(<><b>Identity</b> A signed peer identity, and a verified GitHub account or domain.</>)},
];

/** Trust you can check: your device scoring providers, beside the four signals it uses. */
export default function Trust(): JSX.Element {
  return (
    <Duo
      cmp="network/trust"
      labelledBy="trust-title"
      flip
      className={styles.trust}
      textClassName={styles.text}
      panel={
        <Wash unveil reveal="panel" className={styles.panel} {...PAINTINGS.birches}>
          <ScoreWindow />
        </Wash>
      }
      text={
        <>
          <DuoHead className={styles.head}>
            <Heading as="h2" id="trust-title" strong secondLine="block" title={['Trust you can check.', 'A name is not enough.']} className={styles.title} />
            <Sub className={styles.sub}>Your device scores every provider from public signals and skips the ones below your bar. Independent auditors check that a provider serves the model it claims.</Sub>
          </DuoHead>
          <FeatureList items={SIGNALS} className={styles.signalsList} />
          <Link className={styles.link} to="/docs/reputation/" data-rv="">How trust is computed →</Link>
        </>
      }
    />
  );
}
