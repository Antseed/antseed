import type { FreeTierProgram } from '@antseed/node/free-tier-program';
import { openSellerPool, tierAllowance, tierAnts } from '../../../modules/catalog/free-tier';
import { InfoTooltip } from '../InfoTooltip';
import modelRowStyles from './VprModelRows.module.scss';
import styles from './VprFreeTierStake.module.scss';

/**
 * "Stake for more" on a free seller with staked tiers: the tiers, and a link
 * that opens staking on this seller's pool. Only stake in that pool counts.
 */
export function VprFreeTierStake({ program, agentId }: { program: FreeTierProgram | null | undefined; agentId: number }) {
  if (!program || program.stakeTiers.length === 0) return null;
  const content = (
    <>
      <strong>Raise this seller's free limit</strong>
      <span>Lock ANTS in this seller's pool and its free limit goes up for you. Only stake in this seller's own pool counts.</span>
      <div className={styles.tiers}>
        {program.stakeTiers.map((tier) => (
          <span key={tier.minPower} className={styles.tier}><span>{tierAnts(tier)} for a year</span><span>{tierAllowance(tier)}</span></span>
        ))}
      </div>
      <span>Twice the ANTS for half a year counts the same.</span>
      {agentId > 0 && (
        <span>
          <button type="button" className={styles.link} onClick={(event) => { event.stopPropagation(); openSellerPool(agentId); }}>
            Stake in this seller's pool ↗
          </button>
        </span>
      )}
    </>
  );
  return (
    <InfoTooltip align="left" interactive content={content}>
      <span tabIndex={0} role="button" className={styles.badge} aria-label="Stake for a higher free limit on this seller"
        onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
        <span className={modelRowStyles.modelTag}>Stake for more</span>
      </span>
    </InfoTooltip>
  );
}
