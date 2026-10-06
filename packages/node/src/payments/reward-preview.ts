import type { SellerPoolPosition } from './evm/seller-pools-client.js';

export const REWARD_INDEX_SCALE = 10n ** 30n;

export interface RewardPreviewReader {
  currentEpoch(): Promise<number>;
  claimCursor(positionId: number): Promise<number>;
  indexCursor(agentId: number): Promise<number>;
  segment(positionId: number, epoch: number): Promise<{ normalEnd: bigint; maxLockPower: bigint; nextChange: bigint }>;
  cumulative(agentId: number, epoch: number): Promise<{ reward: bigint; epochReward: bigint }>;
  rewardPerWeight(agentId: number, epoch: number): Promise<bigint>;
}

export async function previewPositionReward(position: SellerPoolPosition, reader: RewardPreviewReader): Promise<bigint> {
  const [currentEpoch, claimedThrough, indexedThrough] = await Promise.all([
    reader.currentEpoch(), reader.claimCursor(position.id), reader.indexCursor(position.agentId),
  ]);
  const toEpoch = position.closedAtEpoch ? Math.min(currentEpoch, position.closedAtEpoch) : currentEpoch;
  let cursor = Math.max(claimedThrough, position.stakeStartEpoch);
  let amount = 0n;
  while (cursor < toEpoch) {
    const segment = await reader.segment(position.id, cursor);
    let end = Number(segment.nextChange < BigInt(toEpoch) ? segment.nextChange : BigInt(toEpoch));
    if (end <= cursor) throw new Error(`Invalid reward segment for position ${position.id}`);
    const normal = segment.maxLockPower === 0n && segment.normalEnd > BigInt(cursor);
    if (normal && segment.normalEnd < BigInt(end)) end = Number(segment.normalEnd);
    if (normal || segment.maxLockPower > 0n) {
      const [fromIndex, toIndex] = await Promise.all([
        reader.cumulative(position.agentId, cursor), reader.cumulative(position.agentId, end),
      ]);
      let rewardDelta = toIndex.reward - fromIndex.reward;
      let epochRewardDelta = toIndex.epochReward - fromIndex.epochReward;
      for (let epoch = Math.max(cursor, indexedThrough); epoch < end; epoch++) {
        const rewardPerWeight = await reader.rewardPerWeight(position.agentId, epoch);
        rewardDelta += rewardPerWeight;
        epochRewardDelta += rewardPerWeight * BigInt(epoch);
      }
      amount += segment.maxLockPower > 0n
        ? segment.maxLockPower * rewardDelta / REWARD_INDEX_SCALE
        : position.weightAmount * (segment.normalEnd * rewardDelta - epochRewardDelta) / REWARD_INDEX_SCALE;
    }
    cursor = end;
  }
  return amount;
}
