import type { SellerPoolsClient } from './evm/seller-pools-client.js';
import type { SellerPoolsRewardsClient } from './evm/seller-pools-rewards-client.js';

export type RewardTransactionRecorder = (hash: string, kind: 'claim' | 'accounting') => Promise<void>;

export async function pendingEpochRewards(
  epochs: number[],
  readPending: (epochs: number[]) => Promise<bigint>,
): Promise<bigint> {
  let amount = 0n;
  for (let offset = 0; offset < epochs.length; offset += 32) {
    amount += await readPending(epochs.slice(offset, offset + 32));
  }
  return amount;
}

export async function claimEpochRewards(
  epochs: number[],
  readPending: (epochs: number[]) => Promise<bigint>,
  claim: (epochs: number[]) => Promise<string>,
  record: RewardTransactionRecorder,
): Promise<void> {
  for (let offset = 0; offset < epochs.length; offset += 32) {
    const batch = epochs.slice(offset, offset + 32);
    if (await readPending(batch) > 0n) await record(await claim(batch), 'claim');
  }
}

export async function claimBuyerEpochRewards(
  epochs: number[],
  readPending: (epoch: number) => Promise<bigint>,
  claim: (epoch: number) => Promise<string>,
  record: RewardTransactionRecorder,
): Promise<void> {
  for (const epoch of epochs) {
    if (await readPending(epoch) > 0n) await record(await claim(epoch), 'claim');
  }
}

type PoolReader = Pick<SellerPoolsClient, 'allStakerPositionIds' | 'positionsBatch' | 'position' | 'currentEpoch'>;
type PoolRewards = Pick<SellerPoolsRewardsClient,
  'previewStakerRewards' | 'pendingIndexedStakerReward' | 'poolRewardIndexNextEpoch' |
  'initialIndexEpoch' | 'indexPoolRewards' | 'claimStakerRewardsBatch'>;
type RewardSigner = Parameters<SellerPoolsRewardsClient['claimStakerRewardsBatch']>[0];

/**
 * Pending staker rewards for the wallet's open positions (the on-chain
 * `stakerPositionIds` enumeration) plus any `includeIds` the caller knows
 * about, typically positions closed by split, merge, or move that an indexer
 * reported; those keep their earned rewards but leave the enumeration.
 */
export async function previewPoolRewards(pools: PoolReader, rewards: PoolRewards, address: string, positionId?: number, options: { includeIds?: number[] } = {}) {
  const positions = positionId === undefined
    ? await pools.positionsBatch([...new Set([...await pools.allStakerPositionIds(address), ...(options.includeIds ?? [])])])
    : [await pools.position(positionId)];
  for (const position of positions) {
    if (position.owner.toLowerCase() !== address.toLowerCase()) throw new Error(`Position ${position.id} is not owned by this wallet.`);
  }
  const amounts = await rewards.previewStakerRewards(positions.map((position) => position.id));
  return positions.map((position, index) => ({ id: position.id, agentId: position.agentId, amount: amounts[index]!, closedAtEpoch: position.closedAtEpoch }));
}

export async function claimPoolRewards(
  pools: PoolReader,
  rewards: PoolRewards,
  wallet: RewardSigner,
  address: string,
  recipient: string,
  record: RewardTransactionRecorder,
  preparing: () => void,
  positionId?: number,
  options: { includeIds?: number[] } = {},
): Promise<void> {
  const pending = await previewPoolRewards(pools, rewards, address, positionId, options);
  const rewardedPositions = pending.filter((position) => position.amount > 0n);
  if (rewardedPositions.length === 0) return;
  const currentEpoch = await pools.currentEpoch();
  for (const agentId of new Set(rewardedPositions.map((position) => position.agentId))) {
    const targetEpoch = rewardedPositions.filter((position) => position.agentId === agentId)
      .reduce((latest, position) => Math.max(latest, Math.min(currentEpoch, position.closedAtEpoch || currentEpoch)), 0);
    let cursor = await rewards.poolRewardIndexNextEpoch(agentId) || await rewards.initialIndexEpoch();
    if (cursor < targetEpoch) preparing();
    while (cursor < targetEpoch) {
      await record(await rewards.indexPoolRewards(wallet, agentId, Math.min(16, targetEpoch - cursor)), 'accounting');
      const next = await rewards.poolRewardIndexNextEpoch(agentId);
      if (next <= cursor) throw new Error('Reward preparation made no progress. Retry the claim later.');
      cursor = next;
    }
  }
  const ids: number[] = [];
  for (const position of rewardedPositions) {
    if (await rewards.pendingIndexedStakerReward(position.id) > 0n) ids.push(position.id);
  }
  for (let offset = 0; offset < ids.length; offset += 32) {
    await record(await rewards.claimStakerRewardsBatch(wallet, ids.slice(offset, offset + 32), recipient), 'claim');
  }
}
