import type { FreeTierProgramView } from '../api/types'
import { freeTierBaseLabel, stakeInPoolPath, tierAnts, tierMultiplier } from '../lib/free-tier'
import { href, linkHandler } from '../lib/router'
import { useConsole } from '../app/context'
import { isWorkspaceAdmin } from '../lib/nav'
import { InfoTip } from './TrustInfo'

/**
 * A free offer's limit and, when the seller has staked tiers, what locking
 * ANTS in this seller's pool raises it to. Stake in other pools never counts.
 */
export function FreeTierInfo({ program, agentId }: { program: FreeTierProgramView | null; agentId: number | null }) {
  const canStake = isWorkspaceAdmin(useConsole().viewer)
  if (!program) return null
  const base = freeTierBaseLabel(program)
  if (program.stakeTiers.length === 0) return <span>{base ?? 'Free'}</span>
  return (
    <span className="gc-inline">
      <span>{base ?? 'Free'} · stake for more</span>
      <InfoTip label="Staked free tier" align="end">
        <span className="gc-tip__title">Raise this seller's free limit</span>
        Lock ANTS in this seller's pool and its free limit goes up for your buyer. Only stake in this seller's own pool counts.
        <span className="gc-free-tiers">
          <span className="gc-free-tiers__row gc-free-tiers__head"><span>Locked for a year</span><span>Free limit</span></span>
          {program.stakeTiers.map((tier) => (
            <span key={tier.minPower} className="gc-free-tiers__row"><span>{tierAnts(tier)}</span><span>{tierMultiplier(tier)}</span></span>
          ))}
        </span>
        Twice the ANTS for half a year counts the same.
        {agentId !== null && (canStake
          ? <span className="gc-free-tiers__link"><a href={href(stakeInPoolPath(agentId))} onClick={linkHandler(stakeInPoolPath(agentId))}>Stake in this seller's pool</a></span>
          : <span className="gc-free-tiers__link">A workspace admin stakes for this workspace.</span>)}
      </InfoTip>
    </span>
  )
}
