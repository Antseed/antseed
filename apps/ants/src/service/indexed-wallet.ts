import type { AntsContext } from './context.js';
import type { RewardPositions } from './position-feed.js';
import { IndexerSyncingError } from '../read-state.js';

/** Live position status older than this is rejected; Antscan refreshes it every 15s. */
const LIVE_MAX_AGE_SECONDS = 15;
const REWARDS_MAX_AGE_SECONDS = 3600;
/** Tolerated clock skew between Antscan and this machine. */
const CLOCK_SKEW_SECONDS = 30;

const nowSeconds = () => Math.floor(Date.now() / 1000);

function validateChain(ctx: AntsContext, data: RewardPositions): void {
  const { source } = data;
  const matches = source.chainId === ctx.chain.evmChainId
    && source.contracts.sellerPools.toLowerCase() === ctx.chain.sellerPoolsAddress?.toLowerCase()
    && source.contracts.sellerPoolsRewards.toLowerCase() === ctx.chain.sellerPoolsRewardsAddress?.toLowerCase();
  if (!matches) throw new Error('Antscan position chain or contracts do not match this dashboard');
}

/** The wallet's positions with live on-chain status from Antscan, accepted only when fresh, complete and past our read barrier. */
export async function liveWalletPositions(ctx: AntsContext, epoch: number): Promise<RewardPositions> {
  const indexer = ctx.indexer();
  if (!indexer?.rewardPositions) throw new Error('Antscan positions are unavailable');
  const data = await indexer.rewardPositions(ctx.address);
  validateChain(ctx, data);
  const { liveSource } = data;
  const now = nowSeconds();
  const fresh = now - liveSource.fetchedAt < LIVE_MAX_AGE_SECONDS && liveSource.fetchedAt <= now + CLOCK_SKEW_SECONDS;
  if (liveSource.currentEpoch !== epoch || liveSource.stale || !liveSource.complete || data.liveError || !fresh) throw new Error(data.liveError ?? 'Antscan live position status is stale or incomplete');
  const barrier = ctx.positionReadBarriers?.get(ctx.address.toLowerCase());
  if (barrier && (liveSource.fetchedAt <= barrier.at || data.source.indexedBlock < barrier.block)) throw new IndexerSyncingError('Antscan live positions have not caught up with your transaction');
  if (data.positions.some(row => row.power == null || row.nextPower == null || row.withdrawableEpoch === null || row.maxLockedNext === null || row.changePending === null)) throw new Error('Antscan live position fields are incomplete');
  return data;
}

/** Indexed staker rewards per position, accepted only for this chain's contracts, a fresh complete snapshot, and past our read barrier. */
export async function indexedWalletRewards(ctx: AntsContext, epoch: number, outstanding = false): Promise<RewardPositions> {
  const indexer = ctx.indexer();
  if (!indexer?.rewardPositions) throw new Error('Antscan indexed rewards are unavailable');
  const data = await indexer.rewardPositions(ctx.address, outstanding);
  return validateWalletRewards(ctx, epoch, data);
}

export function validateWalletRewards(ctx: AntsContext, epoch: number, data: RewardPositions): RewardPositions {
  validateChain(ctx, data);
  const { source } = data;
  const now = nowSeconds();
  const fresh = now - source.indexedAt <= REWARDS_MAX_AGE_SECONDS && source.indexedAt <= now + CLOCK_SKEW_SECONDS;
  if (source.schemaVersion !== 1 || data.currentEpoch !== epoch || source.stale || !fresh) throw new Error('Antscan reward snapshot is stale');
  if (!source.complete || !source.historyComplete || source.historyFromBlock > source.indexedBlock) throw new Error('Antscan reward history is incomplete');
  const barrier = ctx.positionReadBarriers?.get(ctx.address.toLowerCase());
  if (barrier && source.indexedBlock < barrier.block) throw new IndexerSyncingError('Antscan rewards have not caught up with your transaction');
  if (data.positions.some(row => row.rewards.status !== 'available' || row.rewards.pending === null)) throw new Error('Some indexed position rewards are unavailable');
  return data;
}
