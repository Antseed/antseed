
import { parseAbi } from 'viem';

export const DIEM_STAKING_PROXY_ABI = parseAbi([
  'function totalStaked() view returns (uint256)',
  'function staked(address user) view returns (uint256)',
  'function stakerCount() view returns (uint32)',
  'function maxTotalStake() view returns (uint256)',

  'function earnedUsdc(address user) view returns (uint256)',
  'function totalUsdcDistributedEver() view returns (uint256)',

  'function firstRewardEpoch() view returns (uint32)',
  'function syncedRewardEpoch() view returns (uint32)',
  'function finalizedRewardEpoch() view returns (uint32)',
  'function userLastClaimedEpoch(address user) view returns (uint32)',
  'function userEpochClaimed(address user, uint32 rewardEpoch) view returns (bool)',
  'function pendingAntsForEpoch(address user, uint32 rewardEpoch) view returns (uint256)',
  'function syncBacklog() view returns (uint32 finalized, uint32 synced, uint32 remaining)',
  'function userPointsBacklog(address account) view returns (uint32 userEpoch, uint32 synced, uint32 remaining)',
  'function MAX_EPOCHS_PER_CAPTURE() view returns (uint32)',

  'function currentUnstakeBatch() view returns (uint32)',
  'function oldestUnclaimedUnstakeBatch() view returns (uint32)',
  'function unstakeBatches(uint32 id) view returns (uint128 total, uint64 unlockAt, uint32 userCount, bool claimed)',
  'function unstakeBatchUserAmount(uint32 id, address user) view returns (uint128)',

  'function minUnstakeBatchOpenSecs() view returns (uint64)',
  'function currentUnstakeBatchOpenedAt() view returns (uint64)',
  'function flushableAt() view returns (uint64)',

  'function stake(uint256 amount)',
  'function initiateUnstake(uint256 amount)',
  'function flush()',
  'function claimUnstakeBatch(uint32 batchId)',
  'function claimUsdc()',
  'function claimAnts(uint32[] rewardEpochs)',
  'function syncRewardEpochs(uint32 maxEpochs)',
  'function catchUpPoints(uint32 numEpochs)',

  'event UsdcDistributed(uint256 amount)',
  'event RewardEpochClosed(uint32 indexed rewardEpochId, uint256 revenuePerTokenAtEnd, uint256 totalPoints)',
  'event RewardEpochFunded(uint32 indexed rewardEpochId, uint256 antsPot)',
]);

export const DIEM_TOKEN_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function cooldownDuration() view returns (uint256)',
]);
