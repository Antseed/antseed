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

/**
 * One seller-pool position counted toward the workspace's free tier: the
 * buyer's own or a sharing staker's. Mirrors `FreeTierStakePositionView` in
 * `@antseed/node/free-tier-program`.
 */
export interface FreeTierStakePosition {
  id: number
  staker: string
  /** Weighted ANTS; power is this × weeks of lock remaining. */
  ants: number
  /** First epoch the position has power. */
  startEpoch: number
  /** Epoch the lock ends. */
  endEpoch: number
  /** Epoch a moved, split or merged position stops counting, or null. */
  closedAtEpoch: number | null
  /** Max lock is on: power holds at `ants × 104`. */
  maxLocked: boolean
  /** Unix seconds the staker's code expires; null for the buyer's own stake. */
  expiresAt: number | null
}

/** The stake each seller pool counts for the workspace buyer, read live from the chain. */
export interface FreeTierStake {
  buyer: string
  currentEpoch: number
  /** Unix seconds epoch 0 starts. */
  genesis: number
  /** Seconds per epoch. */
  epochDuration: number
  pools: Array<{ agentId: number; positions: FreeTierStakePosition[] }>
}
