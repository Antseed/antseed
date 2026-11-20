import type {JSX} from 'react';
import {Actions, Button, Duo, SectionHead, Wash} from '../../components';
import {GlassCard} from '../../parts/Glass/GlassCard';
import {painting} from '../../lib/paintings';
import styles from './FoundationStaking.module.css';

const APPLICATION = 'https://docs.google.com/forms/d/e/1FAIpQLSdeb4e5bx-aJxVzqb41HrJmWFYNOitszgIM7sZ9fUx-nVbCbQ/viewform';

export function FoundationStaking(): JSX.Element {
  return (
    <Duo cmp="providers/foundation-staking" id="foundation-staking" labelledBy="foundation-staking-title" text={
      <SectionHead
        size="compact"
        eyebrow="Foundation Provider Staking Program"
        id="foundation-staking-title"
        title={['Get Foundation stake', 'behind your provider.']}
        sub="The Foundation may stake ANTS behind active, high-performing providers. Support depends on agreed milestones and requires KYB/KYC screening. Providers that use a TEE or offer a free model receive priority.">
        <Actions reveal>
          <Button href={APPLICATION} size="page">Apply for Foundation staking</Button>
        </Actions>
      </SectionHead>
    } panel={
      <Wash unveil reveal="panel" className={styles.panel} {...painting('/site/assets/providers/staking-ferry')}>
        <GlassCard className={styles.card} title="Foundation staking" rows={[
          {term: 'Who stakes', value: 'Antseed Foundation'},
          {term: 'Where the stake goes', value: 'Your provider pool'},
        ]} />
      </Wash>
    } />
  );
}
