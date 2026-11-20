import type {JSX} from 'react';
import {Actions, Button, Duo, DuoHead, Heading, Sub, Wash} from '../../components';
import {GlassCard, type GlassCardRow} from '../../parts/Glass/GlassCard';
import styles from './Reputation.module.css';
import {painting} from '../../lib/paintings';

const RECORD: readonly GlassCardRow[] = [
  {term: 'Settled usage', value: '12,480 requests · $1,204'},
  {term: 'ANTS staked', value: '25,000 ANTS'},
  {term: 'Responses', value: 'Signed'},
  {term: 'Model fingerprint', value: 'Verified'},
];

/** Reputation: a provider's record on its painting, what builds it beside. */
export function Reputation(): JSX.Element {
  return (
    <Duo
      cmp="providers/rep"
      flip
      className={styles.section}
      labelledBy="providers-reputation-title"
      railClassName={styles.rail}
      textClassName={styles.text}
      panel={
        <Wash unveil reveal="panel" className={styles.panel} {...painting('/site/assets/providers/king', true)}>
          <GlassCard
            title="Your reputation"
            rows={RECORD}
            center
            className={styles.card}
            label="A provider's reputation: its settled usage, the ANTS staked behind it, its responses signed and its model fingerprint verified"
          />
        </Wash>
      }
      text={
        <>
          <div data-rv="">
            <DuoHead className={styles.head}>
              <Heading id="providers-reputation-title" strong secondLine="block" title={['Build your', 'reputation.']} />
              <Sub className={styles.sub}>Settled usage and the ANTS staked behind your provider give buyers a reputation they can check. Responses are signed, and model fingerprints help verify what you serve.</Sub>
            </DuoHead>
          </div>
          <Actions fill reveal>
            <Button href="/docs/provide/" size="page">Provider setup docs</Button>
            <Button href="/docs/provide/staking/" variant="ghost" size="page">Staking docs</Button>
          </Actions>
        </>
      }
    />
  );
}
