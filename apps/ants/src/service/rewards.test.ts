import { ZeroAddress } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import type { AntsContext } from './context.js';
import { IndexerError } from './indexer.js';
import { claim, compound, restake, rewards, stakeUsageRewards } from './rewards.js';

const address = '0x0000000000000000000000000000000000000001';
const foreign = '0x0000000000000000000000000000000000000002';

function fixture(indexed = true) {
  const position = { id: 7, owner: address, agentId: 2, amount: 100n, weightAmount: 100n, stakeStartEpoch: 1, stakeEndEpoch: 12, closedAtEpoch: 5, withdrawn: false };
  const pools = {
    allStakerPositionIds: async (): Promise<number[]> => [],
    positionsBatch: vi.fn(async (ids: number[]) => ids.map((id) => ({ ...position, id, owner: id === 9 ? foreign : address }))),
    poolConfig: async () => ({ minStakeEpochs: 1, maxStakeEpochs: 52 }),
    currentEpoch: async () => 6,
  };
  const poolRewards = {
    previewStakerRewards: async (ids: number[]) => ids.map(() => 10n),
    poolRewardIndexNextEpoch: async () => 6,
    pendingIndexedStakerReward: async () => 10n,
    claimStakerRewardsBatch: vi.fn(async () => 'claim-hash'),
    restakeStakerRewardsBatch: vi.fn(async () => 'restake-hash'),
  };
  const ctx = {
    address, buyerAddress: address, localPositionIds: new Map(),
    stack: async () => ({ phase: 'legacy', currentEpoch: 6 }),
    claimableEpochs: async () => ({ legacy: [], recognized: [] }),
    pools: () => pools,
    poolRewards: () => poolRewards,
    requirePools: () => pools,
    requirePoolRewards: () => poolRewards,
    requireSigner: () => ({}),
    antsToken: () => ({ receivedInTransaction: async () => 10n }),
    usageAccounting: () => null,
    usageRewards: () => null,
    legacyEmissionsAt: () => null,
    lockedPoolAt: () => null,
    sellerRegistry: () => null,
    legacyStakingAt: () => null,
    deposits: () => null,
    indexer: () => indexed ? { positions: async () => [position] } : null,
    invalidate: () => {},
  } as unknown as AntsContext;
  return { ctx, pools, poolRewards };
}

describe('closed-position rewards', () => {
  function indexedFixture() {
    const result = fixture();
    const row = { id: 7, owner: address, agentId: 2, closedAtEpoch: 5, rewards: { status: 'available', pending: '99' } };
    const source = { schemaVersion: 1, chainId: 8453, contracts: { sellerPools: address, sellerPoolsRewards: address }, indexedBlock: 100, indexedAt: Math.floor(Date.now() / 1000), stale: false, complete: true, historyComplete: true, historyFromBlock: 1 };
    const rewardPositions = vi.fn(async () => ({ currentEpoch: 6, positions: [row], source }));
    Object.assign(result.ctx, { chain: { evmChainId: 8453, sellerPoolsAddress: address, sellerPoolsRewardsAddress: address }, indexer: () => ({ rewardPositions, positions: async () => [row] }) });
    return { ...result, rewardPositions, source };
  }

  it('reads outstanding indexed staker rewards without exact previews', async () => {
    const { ctx, poolRewards, rewardPositions } = indexedFixture();
    const preview = vi.spyOn(poolRewards, 'previewStakerRewards');
    expect(await rewards(ctx)).toMatchObject({ staker: { total: '99', positions: [{ id: 7, amount: '99', closed: true }], source: { indexedBlock: 100 } } });
    expect(rewardPositions).toHaveBeenCalledWith(address, false);
    expect(preview).not.toHaveBeenCalled();
  });

  it('keeps buyer/seller buckets available when indexed staking rewards fail', async () => {
    const { ctx, rewardPositions, poolRewards } = indexedFixture();
    rewardPositions.mockRejectedValue(new Error('backfill incomplete'));
    const preview = vi.spyOn(poolRewards, 'previewStakerRewards');
    expect(await rewards(ctx)).toMatchObject({ total: null, staker: { total: null, source: { error: 'backfill incomplete' } }, sellerUsage: { total: '0' }, buyerUsage: { total: '0' } });
    expect(preview).not.toHaveBeenCalled();
  });

  it('reports syncing instead of replacing previous rewards with unknown amounts after a transaction', async () => {
    const { ctx, source } = indexedFixture();
    Object.assign(ctx, { positionReadBarriers: new Map([[address, { block: source.indexedBlock + 1, at: 0 }]]) });
    await expect(rewards(ctx)).rejects.toMatchObject({ name: 'IndexerSyncingError' });
    source.indexedBlock++;
    expect((await rewards(ctx)).staker.total).toBe('99');
  });

  it.each(['claim', 'restake'])('validates indexed candidates live for %s rather than trusting the displayed amount', async action => {
    const { ctx, poolRewards, pools } = indexedFixture();
    const preview = vi.spyOn(poolRewards, 'previewStakerRewards');
    if (action === 'claim') await claim(ctx, { buckets: ['staker'] });
    else await restake(ctx, { epochs: 3 });
    expect(pools.positionsBatch).toHaveBeenCalledWith([7]);
    expect(preview).toHaveBeenCalled();
    expect(action === 'claim' ? poolRewards.claimStakerRewardsBatch : poolRewards.restakeStakerRewardsBatch).toHaveBeenCalled();
  });

  it('preserves known rewards with an incomplete-history marker when the indexer is unreachable', async () => {
    const { ctx, pools } = fixture();
    pools.allStakerPositionIds = async () => [7];
    ctx.indexer = () => ({ positions: async () => { throw new IndexerError('Indexer unavailable', 'unavailable-indexer'); } }) as never;
    expect(await rewards(ctx)).toMatchObject({ historySource: 'chain', staker: { total: '10' } });
  });
  it('does not report zero rewards when the reward preview fails', async () => {
    const { ctx, poolRewards } = fixture();
    poolRewards.previewStakerRewards = async () => { throw new Error('RPC unavailable'); };
    await expect(rewards(ctx)).rejects.toThrow('RPC unavailable');
  });

  it('retains a locked balance when nothing is claimable', async () => {
    const { ctx } = fixture();
    ctx.lockedPoolAt = () => ({ claimable: async () => ({ locked: 246820n * 10n ** 18n, claimable: 0n, policy: '0x0000000000000000000000000000000000000000' }) }) as never;
    expect((await rewards(ctx)).locked).toMatchObject({ locked: '246820000000000000000000', claimable: '0', policy: null });
  });
  it.each([true, false])('keeps legacy rewards visible while resolving their payout (read succeeds: %s)', async (available) => {
    const { ctx } = fixture();
    ctx.stack = async () => ({ phase: 'legacy', currentEpoch: 6, legacyEmissions: foreign }) as never;
    ctx.claimableEpochs = async () => ({ legacy: [5], recognized: [] }) as never;
    ctx.legacyEmissionsAt = () => ({
      pendingEmissions: async () => ({ seller: 5n, buyer: 0n }),
      sellerUnlockPolicy: async () => { if (!available) throw new Error('RPC unavailable'); return ZeroAddress; },
      sellerRewardsPool: async () => foreign,
    }) as never;
    expect(await rewards(ctx)).toMatchObject({ legacy: {
      seller: '5',
      sellerPayout: available ? { destination: 'locked', recipient: foreign } : { destination: 'unknown', recipient: null },
    } });
  });
  it('claims the same closed-position rewards shown in the view', async () => {
    const { ctx, poolRewards } = fixture();
    expect((await rewards(ctx)).staker.total).toBe('10');
    expect(await claim(ctx, { buckets: ['staker'] })).toMatchObject({ claimed: '10', transactions: ['claim-hash'] });
    expect(poolRewards.claimStakerRewardsBatch).toHaveBeenCalledWith({}, [7], address);
  });

  it('restakes indexed closed positions by default', async () => {
    const { ctx, poolRewards } = fixture();
    expect(await restake(ctx, { epochs: 4 })).toMatchObject({ positionIds: [7], transactions: ['restake-hash'] });
    expect(poolRewards.restakeStakerRewardsBatch).toHaveBeenCalledWith({}, [7], 4);
  });

  it('loads explicitly requested closed IDs even without an indexer', async () => {
    const { ctx, pools } = fixture(false);
    expect(await restake(ctx, { positionIds: [7], epochs: 4 })).toMatchObject({ positionIds: [7] });
    expect(pools.positionsBatch).toHaveBeenCalledWith([7]);
  });

  it('does not restake closed positions belonging to another wallet', async () => {
    const { ctx, poolRewards } = fixture(false);
    await expect(restake(ctx, { positionIds: [9], epochs: 4 })).rejects.toThrow('not owned');
    expect(poolRewards.restakeStakerRewardsBatch).not.toHaveBeenCalled();
  });

  it('includes closed-position rewards in compound', async () => {
    const { ctx } = fixture();
    expect(await compound(ctx, { epochs: 4 })).toMatchObject({ restakedPositionIds: [7], transactions: ['restake-hash'] });
  });
});


describe('buyer rewards before browser wallet connection', () => {
  function buyerFixture() {
    const { ctx } = fixture();
    ctx.address = ZeroAddress;
    ctx.stack = async () => ({ phase: 'active', currentEpoch: 23, effectiveEpoch: 22 }) as never;
    ctx.claimableEpochs = async () => ({ legacy: [21], recognized: [22] }) as never;
    const walletRead = vi.fn(() => { throw new Error('Unexpected disconnected wallet read'); });
    ctx.sellerRegistry = () => ({ getAgentId: walletRead }) as never;
    ctx.pools = () => ({ allStakerPositionIds: walletRead }) as never;
    ctx.lockedPoolAt = () => ({ claimable: walletRead }) as never;
    ctx.usageAccounting = () => ({ pendingEmissions: walletRead }) as never;
    const buyerClaimed = vi.fn(async () => false);
    const buyerReward = vi.fn(async () => 7n * 10n ** 18n);
    ctx.usageRewards = () => ({ buyerEpochClaimed: buyerClaimed, pendingBuyerReward: buyerReward }) as never;
    const pendingLegacy = vi.fn(async () => ({ seller: 99n, buyer: 5n * 10n ** 18n }));
    ctx.legacyEmissionsAt = () => ({ pendingEmissions: pendingLegacy }) as never;
    const participant = vi.fn(async () => ({ seller: [], buyer: [{ epoch: 22 }] }));
    ctx.indexer = () => ({ participant, positions: walletRead }) as never;
    const getOperator = vi.fn(async () => foreign);
    ctx.deposits = () => ({ getOperator }) as never;
    return { ctx, walletRead, buyerClaimed, buyerReward, pendingLegacy, participant, getOperator };
  }

  it('reads recognized and legacy rewards for the originating buyer, without zero-address wallet reads', async () => {
    const f = buyerFixture();
    const view = await rewards(f.ctx);
    expect(view).toMatchObject({
      scope: 'buyer', total: '12000000000000000000',
      staker: { total: '0', positions: [] }, sellerUsage: { total: '0' },
      buyerUsage: { total: '7000000000000000000', operator: foreign, claimable: false },
      legacy: { seller: '0', buyer: '5000000000000000000', buyerClaimable: false },
      locked: { claimable: '0' },
    });
    expect(f.participant).toHaveBeenCalledWith(address, 2);
    expect(f.getOperator).toHaveBeenCalledWith(address);
    expect(f.buyerClaimed).toHaveBeenCalledWith(address, 22);
    expect(f.buyerReward).toHaveBeenCalledWith(address, 22);
    expect(f.pendingLegacy).toHaveBeenCalledWith(address, [21]);
    expect(f.walletRead).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps buyer reads tied to the buyer when a separate authorized wallet connects (selected=%s)', async selected => {
    const { ctx } = fixture(false);
    ctx.address = selected ? address : foreign;
    if (selected) ctx.signer = { getAddress: async () => foreign } as never;
    ctx.stack = async () => ({ phase: 'active', currentEpoch: 23 }) as never;
    ctx.claimableEpochs = async () => ({ legacy: [], recognized: [22] }) as never;
    ctx.usageAccounting = () => ({ pendingEmissions: async () => ({ seller: 0n, buyer: 999n }) }) as never;
    const buyerReward = vi.fn(async () => 7n);
    ctx.usageRewards = () => ({ buyerEpochClaimed: async () => false, pendingBuyerReward: buyerReward }) as never;
    ctx.deposits = () => ({ getOperator: async () => foreign }) as never;
    expect(await rewards(ctx)).toMatchObject({ scope: 'all', buyerUsage: { total: '7', claimable: true } });
    expect(buyerReward).toHaveBeenCalledWith(address, 22);
    ctx.deposits = () => ({ getOperator: async () => address }) as never;
    expect(await rewards(ctx)).toMatchObject({ buyerUsage: { total: '7', claimable: false } });
  });

  it('propagates buyer read failures instead of reporting zero rewards', async () => {
    const { ctx, buyerReward } = buyerFixture();
    buyerReward.mockRejectedValueOnce(new Error('Buyer RPC unavailable'));
    await expect(rewards(ctx)).rejects.toThrow('Buyer RPC unavailable');
  });
});

describe('explicit buyer and wallet claim scopes', () => {
  function claimFixture() {
    const { ctx, poolRewards } = fixture(false);
    ctx.address = foreign;
    ctx.stack = async () => ({ phase: 'active', currentEpoch: 23 }) as never;
    ctx.claimableEpochs = async () => ({ legacy: [21], recognized: [22] }) as never;
    ctx.deposits = () => ({ getOperator: async () => foreign }) as never;
    const currentBuyer = vi.fn(async () => 'buyer-current');
    const oldBuyer = vi.fn(async () => 'buyer-legacy');
    const seller = vi.fn(async () => 'seller');
    ctx.usageRewards = () => ({ buyerEpochClaimed: async () => false, pendingBuyerReward: async () => 5n, claimBuyerReward: currentBuyer }) as never;
    ctx.usageAccounting = () => ({ pendingEmissions: async () => ({ seller: 5n }), claimSellerEmissions: seller }) as never;
    ctx.legacyEmissionsAt = () => ({ pendingEmissions: async () => ({ buyer: 5n, seller: 5n }), claimBuyerEmissions: oldBuyer, claimSellerEmissions: seller }) as never;
    return { ctx, currentBuyer, oldBuyer, seller, poolRewards };
  }
  it('claims current and legacy buyer rewards without touching wallet-owned categories', async () => {
    const f = claimFixture();
    const result = await claim(f.ctx, { buckets: [], scope: 'buyer' });
    expect(result.transactions).toEqual(['buyer-current', 'buyer-legacy']);
    expect(f.currentBuyer).toHaveBeenCalledWith({}, address, 22);
    expect(f.oldBuyer).toHaveBeenCalledWith({}, address, [21]);
    expect(f.seller).not.toHaveBeenCalled();
    expect(f.poolRewards.claimStakerRewardsBatch).not.toHaveBeenCalled();
  });
  it('checks the browser signer, not the selected buyer address, for buyer claims', async () => {
    const setup = claimFixture();
    setup.ctx.address = address;
    setup.ctx.signer = { getAddress: async () => foreign } as never;
    const received = vi.fn(async () => 5n);
    setup.ctx.antsToken = () => ({ receivedInTransaction: received }) as never;
    expect((await claim(setup.ctx, { buckets: [], scope: 'buyer' })).transactions).toEqual(['buyer-current', 'buyer-legacy']);
    expect(received).toHaveBeenCalledWith('buyer-current', foreign);
    expect(setup.seller).not.toHaveBeenCalled();
    setup.ctx.signer = { getAddress: async () => address } as never;
    await expect(claim(setup.ctx, { buckets: [], scope: 'buyer' })).rejects.toThrow('authorized wallet');
  });
  it('stakes selected buyer rewards with its separate authorized operator', async () => {
    const setup = claimFixture();
    setup.ctx.address = address;
    const signer = { getAddress: async () => foreign };
    setup.ctx.signer = signer as never;
    setup.ctx.requireSigner = () => signer as never;
    const stakeBuyerReward = vi.fn(async () => 'buyer-stake');
    setup.ctx.usageRewards = () => ({ buyerEpochClaimed: async () => false, pendingBuyerReward: async () => 5n, stakeBuyerReward }) as never;
    expect((await stakeUsageRewards(setup.ctx, { side: 'buyer', stakeAgentId: 42, epochs: 4 })).transactions).toEqual(['buyer-stake']);
    expect(stakeBuyerReward).toHaveBeenCalledWith(signer, address, 22, 42, 4);
    setup.ctx.deposits = () => ({ getOperator: async () => address }) as never;
    await expect(stakeUsageRewards(setup.ctx, { side: 'buyer', stakeAgentId: 42, epochs: 4 })).rejects.toThrow('deposits operator');
  });
  it.each(['buyer', 'legacy'] as const)('claims only the selected buyer source: %s', async (bucket) => {
    const setup = claimFixture();
    const result = await claim(setup.ctx, { buckets: [bucket], scope: 'buyer' });
    expect(result.buckets).toEqual([bucket]);
    expect(result.transactions).toEqual([bucket === 'buyer' ? 'buyer-current' : 'buyer-legacy']);
    expect(setup.currentBuyer).toHaveBeenCalledTimes(bucket === 'buyer' ? 1 : 0);
    expect(setup.oldBuyer).toHaveBeenCalledTimes(bucket === 'legacy' ? 1 : 0);
    expect(setup.seller).not.toHaveBeenCalled();
    expect(setup.poolRewards.claimStakerRewardsBatch).not.toHaveBeenCalled();
  });
  it.each(['buyer', 'legacy'] as const)('rejects unauthorized source-specific buyer claims: %s', async (bucket) => {
    const setup = claimFixture();
    setup.ctx.deposits = () => ({ getOperator: async () => ZeroAddress }) as never;
    await expect(claim(setup.ctx, { buckets: [bucket], scope: 'buyer' })).rejects.toThrow('authorized wallet');
    expect(setup.currentBuyer).not.toHaveBeenCalled();
    expect(setup.oldBuyer).not.toHaveBeenCalled();
    expect(setup.seller).not.toHaveBeenCalled();
  });
  it.each([true, false])('checks the reviewed legacy seller destination before transactions (matches: %s)', async (matches) => {
    const setup = claimFixture();
    const legacy = setup.ctx.legacyEmissionsAt(null)!;
    setup.ctx.legacyEmissionsAt = () => ({ ...legacy, sellerUnlockPolicy: async () => ZeroAddress, sellerRewardsPool: async () => address }) as never;
    const request = { buckets: ['legacy'] as const, scope: 'wallet' as const, expectedLegacySellerRecipient: matches ? address : foreign };
    const result = claim(setup.ctx, { ...request, buckets: [...request.buckets] });
    if (matches) {
      await result;
      expect(setup.seller).toHaveBeenCalledOnce();
    } else {
      await expect(result).rejects.toThrow('destination changed or could not be verified');
      expect(setup.seller).not.toHaveBeenCalled();
    }
    expect(setup.oldBuyer).not.toHaveBeenCalled();
    expect(setup.currentBuyer).not.toHaveBeenCalled();
  });
  it('blocks a legacy seller claim when its reviewed destination can no longer be read', async () => {
    const setup = claimFixture();
    await expect(claim(setup.ctx, { buckets: ['seller', 'legacy'], scope: 'wallet', expectedLegacySellerRecipient: foreign })).rejects.toThrow('could not be verified');
    expect(setup.seller).not.toHaveBeenCalled();
  });
  it('rejects unauthorized buyer claims before any transaction, including legacy-only claims', async () => {
    const f = claimFixture();
    f.ctx.deposits = () => ({ getOperator: async () => ZeroAddress }) as never;
    await expect(claim(f.ctx, { buckets: [], scope: 'buyer' })).rejects.toThrow('authorized wallet');
    expect(f.currentBuyer).not.toHaveBeenCalled(); expect(f.oldBuyer).not.toHaveBeenCalled(); expect(f.seller).not.toHaveBeenCalled();
  });
  it('wallet-scoped claims exclude both current and legacy buyer rewards', async () => {
    const f = claimFixture();
    await claim(f.ctx, { buckets: ['buyer', 'legacy', 'seller'], scope: 'wallet' });
    expect(f.currentBuyer).not.toHaveBeenCalled(); expect(f.oldBuyer).not.toHaveBeenCalled();
    expect(f.seller).toHaveBeenCalledTimes(2);
  });
});
