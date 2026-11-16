/**
 * Wire types of the workspace staked free-tier routes: stakers share their
 * seller-pool stake with the workspace's buyer address by handing it a code
 * from the ANTS staking dashboard (My positions → Share free tier).
 *
 * GET    /workspaces/:id/free-tier            → FreeTierSharing  (any workspace member)
 * GET    /workspaces/:id/free-tier/stake      → FreeTierStake    (any workspace member)
 * POST   /workspaces/:id/free-tier  { code }  → FreeTierSharing  (workspace admin)
 * DELETE /workspaces/:id/free-tier/:staker    → FreeTierSharing  (workspace admin)
 */
import type { FreeTierStakePositionView, FreeTierStakeView } from '@antseed/node/free-tier-stake'

/**
 * A seller's free-tier program from its peer metadata: the base limits every
 * buyer gets, and the staked tiers that raise them. Only stake in that
 * seller's own pool counts toward its tiers.
 */
export interface FreeTierProgramView {
  base: {
    maxRequestsPerAddress: number | null
    maxRequestsPerIp: number | null
    windowMs: number
    /** Only buyers whose stake reaches a tier get free use; the base limits are the unit tiers multiply. */
    stakersOnly?: boolean
  }
  /** `minPower` in ANTS-epochs (ANTS × weeks of lock remaining); empty when the seller has no staked tiers. */
  stakeTiers: Array<{ minPower: number; multiplier: number | 'unlimited' }>
}

export interface FreeTierStaker {
  staker: string
  /** Unix seconds. */
  expiresAt: number
  expired: boolean
}

export interface FreeTierSharing {
  /** The workspace's buyer address; codes must name it. */
  buyer: string
  stakers: FreeTierStaker[]
}

/** One seller-pool position counted toward the workspace's free tier: the buyer's own or a sharing staker's. */
export type FreeTierStakePosition = FreeTierStakePositionView

/** The stake each seller pool counts for the workspace buyer, read live from the chain. */
export interface FreeTierStake extends FreeTierStakeView {
  buyer: string
}
