import type { FreeTierProgramView } from '../api/types'
import { freeTierHeadline, stakeInPoolPath, tierAnts, tierLimit } from '../lib/free-tier'
import { href, linkHandler } from '../lib/router'
import { useConsole } from '../app/context'
import { isWorkspaceAdmin } from '../lib/nav'
import { InfoTip } from './TrustInfo'

/**
 * An offer's free-tier program: on a free model its limit, on a priced one
 * the free allowance before the listed price applies. When the seller has
 * staked tiers, what locking ANTS in this seller's pool earns; a stakers-only
 * program serves no one below the first tier. Stake in other pools never counts.
 */
export function FreeTierInfo({ program, agentId, priced = false }: {
  program: FreeTierProgramView | null
  agentId: number | null
  /** The offer has a listed price: requests past the allowance are paid. */
  priced?: boolean
}) {
  const canStake = isWorkspaceAdmin(useConsole().viewer)
  if (!program) return null
  const headline = freeTierHeadline(program, priced)
  if (program.stakeTiers.length === 0) return <span>{headline}</span>
  const stakersOnly = program.base.stakersOnly === true
  return (
    <span className="gc-inline">
      <span>{stakersOnly ? headline : `${headline} · stake for more`}</span>
      <InfoTip label="Staked free tier" align="end">
        <span className="gc-tip__title">{stakersOnly ? "Free for this seller's stakers" : "Raise this seller's free limit"}</span>
        {stakersOnly
          ? <>Lock ANTS in this seller's pool to use this model free{priced ? ' instead of paying' : ''}. {priced ? 'Without enough stake, requests are paid at the listed price.' : 'Without enough stake, this seller does not serve it.'}</>
          : <>Lock ANTS in this seller's pool and its free limit goes up for your buyer.{priced ? ' Past the free limit, requests are paid at the listed price.' : ''}</>}
        {' '}Only stake in this seller's own pool counts.
        <span className="gc-free-tiers">
          <span className="gc-free-tiers__row gc-free-tiers__head"><span>Locked for a year</span><span>Free requests</span></span>
          {program.stakeTiers.map((tier) => (
            <span key={tier.minPower} className="gc-free-tiers__row"><span>{tierAnts(tier)}</span><span>{tierLimit(program, tier)}</span></span>
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
