import type { AntsContext } from '@antseed/ants'
import { pendingEpochRewards } from '@antseed/node/payments'
import type { SellerStanding } from '../gateway/console-api/types.js'
import { sharedChainProvider } from '../proxy/chain-rpc.js'
import { withRpcSource } from '../proxy/rpc-sources.js'
import { peerKey } from './market.js'

/** Standing moves with epochs (stake activation, usage points, emissions): reuse it until the epoch ends, at most this long. */
export const STANDING_MAX_TTL_MS = 30 * 60_000
const STANDING_MIN_TTL_MS = 2 * 60_000

export interface StandingRead {
  standing: SellerStanding
  /** Unix ms when the current epoch ends; null when the chain does not say. */
  epochEndsAt: number | null
}

/** Reuse a read until the epoch ends (between 2 and 30 minutes). */
export function standingTtlMs(read: StandingRead, loadedAt: number): number {
  if (read.epochEndsAt === null) return STANDING_MAX_TTL_MS
  return Math.min(STANDING_MAX_TTL_MS, Math.max(STANDING_MIN_TTL_MS, read.epochEndsAt - loadedAt))
}

const contexts = new Map<string, Promise<AntsContext>>()

/**
 * One read-only ants context per seller address and config, kept for the
 * process: its contract clients and resolved stack are reused, and every read
 * goes through the CLI's shared ChainRpcProvider (concurrent calls coalesced
 * and batched into Multicall3, back-off on errors and 429s).
 */
async function sellerAntsContext(configPath: string, address: string, env: NodeJS.ProcessEnv): Promise<AntsContext> {
  const key = `${configPath}|${address}`
  let context = contexts.get(key)
  if (!context) {
    context = (async () => {
      const ants = await import('@antseed/ants')
      const chain = await ants.resolveAntsChain(configPath, env)
      return new ants.AntsContext({ chain, address, provider: sharedChainProvider(chain) })
    })()
    context.catch(() => contexts.delete(key))
    contexts.set(key, context)
  }
  return context
}

/**
 * The seller's on-chain standing, read-only: registration and eligibility, its
 * staking pool and pending usage rewards. Pool statistics (buyers, requests,
 * ghost rate) come from the explorer when it answers; without it those stay
 * empty and the rest still shows.
 */
export async function readSellerStanding(options: { peerId: string; configPath: string; env?: NodeJS.ProcessEnv }): Promise<StandingRead> {
  return withRpcSource('standing', async () => {
    const ants = await import('@antseed/ants')
    const ctx = await sellerAntsContext(options.configPath, `0x${peerKey(options.peerId)}`, options.env ?? process.env)
    const view = await ants.seller(ctx)
    const [pool, rewards, stack] = await Promise.all([
      view.agentId ? ants.singlePool(ctx, view.agentId).catch(() => null) : Promise.resolve(null),
      pendingSellerUsage(ctx).catch(() => null),
      ctx.stack().catch(() => null),
    ])
    const antsText = (value: string | null | undefined) => (value === null || value === undefined ? null : ants.formatAnts(value).replace(/,/g, ''))
    const epochEndsAt = stack && stack.epochDuration > 0 ? (stack.genesis + (stack.currentEpoch + 1) * stack.epochDuration) * 1000 : null
    return {
      epochEndsAt,
      standing: {
        address: view.address,
        agentId: view.agentId,
        identityRegistered: view.identityRegistered,
        registryBound: view.registryBound,
        eligible: view.eligible,
        minPoolStake: antsText(view.minPoolStake),
        poolActiveStake: antsText(view.poolActiveStake) ?? '0',
        pool: pool ? {
          powerShareBps: pool.powerShareBps,
          stakers: pool.stakers ?? null,
          uniqueBuyers: pool.profile?.uniqueBuyers ?? null,
          requestCount: pool.profile?.requestCount ?? null,
          // The explorer reports micro-USDC.
          lifetimeVolumeUsdc: pool.profile?.lifetimeVolumeUsdc ? String(Number(BigInt(pool.profile.lifetimeVolumeUsdc)) / 1_000_000) : null,
          ghostRate: pool.profile?.ghostRate ?? null,
          lastEpochEmission: antsText(pool.lastEpochEmission),
        } : null,
        pendingRewards: rewards === null ? null : antsText(rewards.toString()),
      },
    }
  })
}

/**
 * The seller's unclaimed usage rewards over the claimable epochs: only the
 * seller bucket, not the wallet's full rewards view (positions, buyer, legacy).
 */
async function pendingSellerUsage(ctx: AntsContext): Promise<bigint> {
  const [stack, epochs] = await Promise.all([ctx.stack(), ctx.claimableEpochs()])
  const usageAccounting = ctx.usageAccounting()
  if (stack.phase !== 'active' || !usageAccounting || epochs.recognized.length === 0) return 0n
  return pendingEpochRewards(epochs.recognized, async (batch) => (await usageAccounting.pendingEmissions(ctx.address, batch)).seller)
}

/**
 * Registration and stake only (`antseed seller status`): the ants `seller`
 * read, on the same cached context and shared provider as the dashboard.
 */
export async function readSellerRegistration(options: { address: string; configPath: string; env?: NodeJS.ProcessEnv }) {
  return withRpcSource('seller-status', async () => {
    const ants = await import('@antseed/ants')
    return ants.seller(await sellerAntsContext(options.configPath, options.address, options.env ?? process.env))
  })
}
