import type { FreeTierProgram } from '@antseed/node/free-tier-program';
import { freeTierHeadline, tierAnts, tierLimit } from '../../../modules/catalog/free-tier';
import { useOpenSellerPool } from '../../hooks/useOpenSellerPool';
import { InfoTooltip } from '../InfoTooltip';
import modelRowStyles from './VprModelRows.module.scss';
import styles from './VprFreeTierStake.module.scss';

/**
 * A route's free-tier program. On a free route with staked tiers, "Stake for
 * more"; on a stakers-only one, "Free for stakers"; on a priced route, its free
 * allowance before the listed price applies. The tooltip lists the tiers and
 * opens staking on this seller's pool: only stake in that pool counts.
 */
export function VprFreeTierStake({ program, agentId, priced = false }: {
  program: FreeTierProgram | null | undefined;
  agentId: number;
  /** The route has a listed price: requests past the allowance are paid. */
  priced?: boolean;
}) {
  const pool = useOpenSellerPool();
  if (!program) return null;
  const stakersOnly = program.base.stakersOnly === true;
  const label = stakersOnly ? 'Free for stakers' : priced ? 'Free allowance' : 'Stake for more';
  if (program.stakeTiers.length === 0) {
    // Nothing to stake for: a priced route still shows its allowance.
    return priced ? <span className={modelRowStyles.modelTag} title={freeTierHeadline(program, true)}>{label}</span> : null;
  }
  const content = (
    <>
      <strong>{stakersOnly ? "Free for this seller's stakers" : priced ? freeTierHeadline(program, true) : "Raise this seller's free limit"}</strong>
      <span>
        {stakersOnly
          ? `Lock ANTS in this seller's pool to use this model free${priced ? ' instead of paying' : ''}. ${priced ? 'Without enough stake, requests are paid at the listed price.' : 'Without enough stake, this seller does not serve it.'}`
          : `Lock ANTS in this seller's pool and its free limit goes up for you.${priced ? ' Past the free limit, requests are paid at the listed price.' : ''}`}
        {' '}Only stake in this seller's own pool counts.
      </span>
      <div className={styles.tiers}>
        {program.stakeTiers.map((tier) => (
          <span key={tier.minPower} className={styles.tier}><span>{tierAnts(tier)} for a year</span><span>{tierLimit(program, tier)}</span></span>
        ))}
      </div>
      <span>Twice the ANTS for half a year counts the same.</span>
      {agentId > 0 && (
        <span>
          <button type="button" className={styles.link} disabled={pool.opening} onClick={(event) => { event.stopPropagation(); pool.open(agentId); }}>
            {pool.opening ? 'Opening…' : "Stake in this seller's pool ↗"}
          </button>
        </span>
      )}
      {pool.error ? <span role="alert">{pool.error}</span> : null}
    </>
  );
  return (
    <InfoTooltip align="left" interactive content={content}>
      <span tabIndex={0} role="button" className={styles.badge} aria-label={`${label}: staking on this seller`}
        onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
        <span className={modelRowStyles.modelTag}>{label}</span>
      </span>
    </InfoTooltip>
  );
}
