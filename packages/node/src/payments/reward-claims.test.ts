import assert from 'node:assert/strict';
import { test } from 'vitest';
import { previewPositionReward, REWARD_INDEX_SCALE, type RewardPreviewReader } from './reward-preview.js';
import { claimBuyerEpochRewards, claimEpochRewards, claimPoolRewards, previewPoolRewards } from './reward-claims.js';
import type { SellerPoolPosition } from './evm/seller-pools-client.js';
import type { AbstractSigner } from 'ethers';

const position: SellerPoolPosition = {
  id: 1, owner: 'seller', agentId: 7, amount: 1n, weightAmount: 1n,
  stakeStartEpoch: 1, stakeEndEpoch: 4, closedAtEpoch: 0, withdrawn: false,
};

function previewReader(indexedThrough: number, overrides: Partial<RewardPreviewReader> = {}): RewardPreviewReader {
  const rates = new Map([[1, REWARD_INDEX_SCALE / 5n], [2, 3n * REWARD_INDEX_SCALE / 10n]]);
  return {
    currentEpoch: async () => 3,
    claimCursor: async () => 0,
    indexCursor: async () => indexedThrough,
    segment: async () => ({ normalEnd: 4n, maxLockPower: 0n, nextChange: 2n ** 256n - 1n }),
    cumulative: async (_agentId, epoch) => {
      let reward = 0n;
      let epochReward = 0n;
      for (const [rateEpoch, rate] of rates) {
        if (rateEpoch < Math.min(epoch, indexedThrough)) {
          reward += rate;
          epochReward += rate * BigInt(rateEpoch);
        }
      }
      return { reward, epochReward };
    },
    rewardPerWeight: async (_agentId, epoch) => {
      assert.ok(epoch < 3, 'must not include the current epoch');
      return rates.get(epoch) ?? 0n;
    },
    ...overrides,
  };
}

test('read-only preview preserves payout rounding before, during, and after indexing', async () => {
  for (const indexedThrough of [1, 2, 3]) {
    assert.equal(await previewPositionReward(position, previewReader(indexedThrough)), 1n);
  }
});

test('preview excludes claimed epochs and retains earned rewards after withdrawal', async () => {
  const withdrawn = { ...position, withdrawn: true, closedAtEpoch: 3 };
  assert.equal(await previewPositionReward(withdrawn, previewReader(1)), 1n);
  assert.equal(await previewPositionReward(withdrawn, previewReader(3, { claimCursor: async () => 3 })), 0n);
  assert.equal(await previewPositionReward({ ...position, closedAtEpoch: 2 }, previewReader(1)), 0n);
});

test('preview uses separate floor rounding for extended and max-lock segments', async () => {
  const reader = previewReader(1, {
    segment: async (_id, epoch) => epoch === 1
      ? { normalEnd: 4n, maxLockPower: 0n, nextChange: 2n }
      : { normalEnd: 0n, maxLockPower: 5n, nextChange: 99n },
  });
  assert.equal(await previewPositionReward(position, reader), 1n);
  assert.equal(await previewPositionReward(position, previewReader(1, {
    segment: async (_id, epoch) => ({ normalEnd: epoch === 1 ? 4n : 7n, maxLockPower: 0n, nextChange: epoch === 1 ? 2n : 99n }),
  })), 1n);
});

test('buyer claims include unpaid epochs older than the last 104', async () => {
  const claimed: number[] = [];
  await claimBuyerEpochRewards(Array.from({ length: 106 }, (_, epoch) => epoch),
    async (epoch) => epoch === 0 || epoch === 105 ? 5n : 0n,
    async (epoch) => { claimed.push(epoch); return `tx-${epoch}`; }, async () => {});
  assert.deepEqual(claimed, [0, 105]);
});

test('epoch claims use bounded batches without discarding old epochs', async () => {
  const batches: number[][] = [];
  await claimEpochRewards(Array.from({ length: 105 }, (_, epoch) => epoch), async () => 1n,
    async (epochs) => { batches.push(epochs); return 'tx'; }, async () => {});
  assert.deepEqual(batches.map((batch) => batch.length), [32, 32, 32, 9]);
  assert.equal(batches.flat().length, 105);
});

function poolFixture(closedAtEpoch = 0) {
  let cursor = 1;
  let wasClaimed = false;
  const writes: string[] = [];
  const targetEpoch = closedAtEpoch || 35;
  const pools = {
    allStakerPositionIds: async () => [position.id],
    positionsBatch: async () => [{ ...position, withdrawn: closedAtEpoch !== 0, closedAtEpoch }],
    position: async () => position,
    currentEpoch: async () => 35,
  };
  const rewards = {
    previewStakerRewards: async (ids: number[]) => ids.map(() => wasClaimed ? 0n : 12n),
    pendingIndexedStakerReward: async () => cursor === targetEpoch && !wasClaimed ? 12n : 0n,
    poolRewardIndexNextEpoch: async () => cursor,
    initialIndexEpoch: async () => 1,
    indexPoolRewards: async (_wallet: AbstractSigner, _agentId: number, maxEpochs: number) => {
      assert.ok(maxEpochs <= 16);
      cursor += maxEpochs;
      writes.push('index');
      return `index-${cursor}`;
    },
    claimStakerRewardsBatch: async (_wallet: AbstractSigner, ids: number[]) => {
      assert.equal(cursor, targetEpoch);
      assert.deepEqual(ids, [1]);
      writes.push('claim');
      wasClaimed = true;
      return 'claim-confirmed';
    },
  };
  return { pools, rewards, writes };
}

test('view previews unindexed historical earnings without writing; claim prepares and pays once', async () => {
  const { pools, rewards, writes } = poolFixture();
  const displayed = await previewPoolRewards(pools, rewards, 'seller');
  assert.equal(displayed[0]!.amount, 12n);
  assert.deepEqual(writes, []);
  const confirmed: string[] = [];
  await claimPoolRewards(pools, rewards, {} as AbstractSigner, 'seller', 'seller', async (hash) => { confirmed.push(hash); }, () => {});
  assert.deepEqual(writes, ['index', 'index', 'index', 'claim']);
  assert.equal(confirmed.at(-1), 'claim-confirmed');
  await claimPoolRewards(pools, rewards, {} as AbstractSigner, 'seller', 'seller', async () => {}, () => {});
  assert.equal(writes.length, 4);
});

test('claim stops if indexing fails instead of claiming an incomplete amount', async () => {
  const { pools, rewards, writes } = poolFixture();
  rewards.indexPoolRewards = async () => { throw new Error('gas unavailable'); };
  await assert.rejects(claimPoolRewards(pools, rewards, {} as AbstractSigner, 'seller', 'seller', async () => {}, () => {}), /gas unavailable/);
  assert.deepEqual(writes, []);
});

test('withdrawn positions only prepare accounting through their closing epoch', async () => {
  const { pools, rewards, writes } = poolFixture(3);
  await claimPoolRewards(pools, rewards, {} as AbstractSigner, 'seller', 'seller', async () => {}, () => {});
  assert.deepEqual(writes, ['index', 'claim']);
});

test('claims include indexed closed positions absent from the live enumeration', async () => {
  const { pools, rewards, writes } = poolFixture(3);
  pools.allStakerPositionIds = async () => [];
  pools.positionsBatch = async (ids?: number[]) => ids?.includes(1) ? [{ ...position, closedAtEpoch: 3, withdrawn: true }] : [];
  await claimPoolRewards(pools, rewards, {} as AbstractSigner, 'seller', 'seller', async () => {}, () => {}, undefined, { includeIds: [1] });
  assert.deepEqual(writes, ['index', 'claim']);
});

test('pool preview requests all position amounts in one snapshot operation', async () => {
  const { pools, rewards } = poolFixture();
  pools.allStakerPositionIds = async () => [1, 2];
  pools.positionsBatch = async () => [position, { ...position, id: 2 }];
  let calls = 0;
  rewards.previewStakerRewards = async (ids) => {
    calls++;
    assert.deepEqual(ids, [1, 2]);
    return [12n, 24n];
  };
  const preview = await previewPoolRewards(pools, rewards, 'seller');
  assert.equal(calls, 1);
  assert.deepEqual(preview.map((entry) => entry.amount), [12n, 24n]);
});

test('pool claims stop when indexing confirms without advancing the cursor', async () => {
  const { pools, rewards, writes } = poolFixture();
  rewards.indexPoolRewards = async () => 'index-confirmed';
  const confirmed: string[] = [];
  await assert.rejects(claimPoolRewards(pools, rewards, {} as AbstractSigner, 'seller', 'seller', async (hash) => { confirmed.push(hash); }, () => {}), /no progress/);
  assert.deepEqual(confirmed, ['index-confirmed']);
  assert.deepEqual(writes, []);
});
