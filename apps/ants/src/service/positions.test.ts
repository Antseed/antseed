import { describe, expect, it, vi } from 'vitest';
import type { AntsContext } from './context.js';
import { extend, maxLock, merge, move, positions, previewWithdraw, split, stake, withdraw } from './positions.js';
import { stakeEligibility } from './stake-eligibility.js';

vi.mock('./stake-eligibility.js', () => ({ stakeEligibility: vi.fn() }));

function fixture() {
  const address = '0x0000000000000000000000000000000000000001';
  const signer = {};
  vi.mocked(stakeEligibility).mockImplementation(async (_ctx, ids) => new Map(ids.map(id => [id, { owner: address, stakeable: true }])));
  const pools = {
    positionsBatch: vi.fn(async (ids: number[]) => ids.map(id => ({ id, owner: address, agentId: 1, amount: 100n, weightAmount: 100n, stakeStartEpoch: 1, stakeEndEpoch: 5, closedAtEpoch: 0, withdrawn: false }))),
    positionWithdrawableEpoch: vi.fn(async () => 1),
    isMaxLocked: vi.fn(async () => false),
    currentEpoch: vi.fn(async () => 2),
    positionPowerSegmentAt: vi.fn(async (_id: number, _epoch: number) => ({ normalEndEpoch: 5, maxLockPower: 0n, nextChangeEpoch: 0 })),
    moveStake: vi.fn(async () => 'single-hash'),
    moveStakes: vi.fn(async () => 'batch-hash'),
    splitStake: vi.fn(),
  };
  const ctx = {
    address,
    requirePools: () => pools,
    requireSigner: () => signer,
    stack: async () => ({ currentEpoch: 2 }),
    sellerRegistry: () => ({ agentSeller: async () => address }),
    localPositionIds: new Map<number, string>(),
  } as unknown as AntsContext;
  return { ctx, pools, signer, address };
}

describe('position display reads', () => {
  function displayFixture() {
    const { ctx, pools } = fixture();
    const statuses = vi.fn(async () => [{ withdrawableEpoch: 1, maxLocked: false, slashBps: 1000 }]);
    Object.assign(pools, {
      allStakerPositionIds: async () => [7],
      poolConfig: async () => ({ minStakeEpochs: 1, maxStakeEpochs: 26, maxSlashBps: 9000, minEarlyExitSlashBps: 0 }),
      positionStatusesBatch: statuses,
    });
    const rewards = vi.fn(async () => [15n]);
    Object.assign(ctx, { indexer: () => null, poolRewards: () => ({ previewStakerRewards: rewards }) });
    return { ctx, pools, statuses, rewards };
  }

  it('uses batched statuses while preserving penalties, rewards, and totals', async () => {
    const { ctx, pools, statuses, rewards } = displayFixture();
    const result = await positions(ctx);
    expect(statuses).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 7 })]), 2);
    expect(pools.positionWithdrawableEpoch).not.toHaveBeenCalled();
    expect(pools.isMaxLocked).not.toHaveBeenCalled();
    expect(rewards).toHaveBeenCalledWith([7]);
    expect(result.positions[0]).toMatchObject({ id: 7, slashedAmount: '10', returnedAmount: '90', pendingReward: '15', changePending: false, maxLocked: false });
    expect(result.totals).toEqual({ activeStake: '100', pendingStake: '0', pendingRewards: '15', open: 1 });
  });

  it('does not present failed status or reward reads as zero balances', async () => {
    const { ctx, statuses, rewards } = displayFixture();
    statuses.mockRejectedValueOnce(new Error('status unavailable'));
    await expect(positions(ctx)).rejects.toThrow('status unavailable');
    rewards.mockRejectedValueOnce(new Error('reward unavailable'));
    await expect(positions(ctx)).rejects.toThrow('reward unavailable');
  });
});

describe('staking registration checks', () => {
  function stakeFixture() {
    const { ctx, pools, signer } = fixture();
    const submit = vi.fn(async () => 'stake-hash');
    Object.assign(pools, { poolConfig: async () => ({ minStakeEpochs: 1, maxStakeEpochs: 104 }), stake: submit });
    const agentSeller = vi.fn(async () => '0x0000000000000000000000000000000000000000');
    Object.assign(ctx, {
      sellerRegistry: () => ({ agentSeller }),
      antsToken: () => ({ balanceOf: async () => 100n * 10n ** 18n, canTransfer: async () => true }),
      invalidate: vi.fn(),
    });
    return { ctx, signer, submit, agentSeller };
  }

  it('accepts a contract-eligible seller without an explicit new-registry binding', async () => {
    const { ctx, signer, submit, agentSeller } = stakeFixture();
    expect(await stake(ctx, { agentId: 59096, amount: '1', epochs: 2 })).toMatchObject({ hash: 'stake-hash' });
    expect(stakeEligibility).toHaveBeenCalledWith(ctx, [59096]);
    expect(agentSeller).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith(signer, 59096, 10n ** 18n, 2);
  });

  it('rejects an ineligible current owner before submitting a transaction', async () => {
    const { ctx, submit } = stakeFixture();
    vi.mocked(stakeEligibility).mockResolvedValueOnce(new Map([[59096, { owner: null, stakeable: false }]]));
    await expect(stake(ctx, { agentId: 59096, amount: '1', epochs: 2 })).rejects.toThrow('not registered to its current owner');
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps RPC verification failures distinct from registration failures', async () => {
    const { ctx, submit } = stakeFixture();
    vi.mocked(stakeEligibility).mockRejectedValueOnce(new Error('RPC unavailable'));
    await expect(stake(ctx, { agentId: 59096, amount: '1', epochs: 2 })).rejects.toThrow('RPC unavailable');
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('whole-position moves', () => {
  it('moves a complete position in one transaction and remembers its source rewards', async () => {
    const { ctx, pools, signer, address } = fixture();
    expect(await move(ctx, { positionIds: [7], toAgentId: 2 })).toEqual({ hash: 'single-hash' });
    expect(pools.moveStake).toHaveBeenCalledWith(signer, 7, 2);
    expect(pools.moveStakes).not.toHaveBeenCalled();
    expect(pools.splitStake).not.toHaveBeenCalled();
    expect(ctx.localPositionIds.get(7)).toBe(address);
  });

  it('moves multiple complete positions in one transaction', async () => {
    const { ctx, pools, signer } = fixture();
    expect(await move(ctx, { positionIds: [7, 8], toAgentId: 2 })).toEqual({ hash: 'batch-hash' });
    expect(pools.moveStakes).toHaveBeenCalledWith(signer, [7, 8], 2);
    expect(pools.moveStake).not.toHaveBeenCalled();
    expect(pools.splitStake).not.toHaveBeenCalled();
    expect([...ctx.localPositionIds.keys()]).toEqual([7, 8]);
  });

  it('rejects obsolete partial requests rather than silently moving the whole position', async () => {
    const { ctx, pools } = fixture();
    const request = { positionIds: [7], toAgentId: 2, amount: '40' };
    await expect(move(ctx, request)).rejects.toThrow('Partial moves are not supported');
    expect(pools.positionsBatch).not.toHaveBeenCalled();
    expect(pools.moveStake).not.toHaveBeenCalled();
    expect(pools.splitStake).not.toHaveBeenCalled();
  });

  it('accepts pending activation but still rejects effective maximum lock', async () => {
    const { ctx, pools } = fixture();
    pools.positionWithdrawableEpoch.mockResolvedValueOnce(3);
    await expect(move(ctx, { positionIds: [7], toAgentId: 2 })).resolves.toEqual({ hash: 'single-hash' });
    expect(pools.positionWithdrawableEpoch).not.toHaveBeenCalled();
    pools.moveStake.mockClear();
    pools.positionPowerSegmentAt.mockResolvedValueOnce({ normalEndEpoch: 0, maxLockPower: 100n, nextChangeEpoch: 0 });
    await expect(move(ctx, { positionIds: [7], toAgentId: 2 })).rejects.toThrow('Disable maximum lock');
    expect(pools.moveStake).not.toHaveBeenCalled();
  });
});

describe('same-epoch position actions', () => {
  function pendingFixture() {
    const { ctx, pools, signer, address } = fixture();
    pools.positionsBatch.mockImplementation(async ids => ids.map(id => ({ id, owner: address, agentId: 1, amount: 100n * 10n ** 18n, weightAmount: 100n * 10n ** 18n, stakeStartEpoch: 3, stakeEndEpoch: 107, closedAtEpoch: 0, withdrawn: false })));
    pools.positionWithdrawableEpoch.mockResolvedValue(3);
    pools.positionPowerSegmentAt.mockResolvedValue({ normalEndEpoch: 107, maxLockPower: 0n, nextChangeEpoch: 0 });
    const writes = {
      mergeStakes: vi.fn(async () => 'merge-hash'),
      enableMaxLock: vi.fn(async () => 'enable-hash'),
      disableMaxLock: vi.fn(async () => 'disable-hash'),
      extendLock: vi.fn(async () => 'extend-hash'),
      withdrawStakes: vi.fn(),
    };
    Object.assign(pools, writes, { contractAddress: address, poolConfig: async () => ({ maxStakeEpochs: 104 }) });
    pools.splitStake.mockResolvedValue('split-hash');
    const call = vi.fn(async (_request: unknown) => '0x');
    Object.assign(ctx, { provider: () => ({ call }) });
    return { ctx, pools, signer, call, writes };
  }

  it('enables max lock and chains another split on pending replacements', async () => {
    const { ctx, pools, signer, writes } = pendingFixture();
    await expect(maxLock(ctx, { positionId: 7, enable: true })).resolves.toEqual({ hash: 'enable-hash' });
    expect(writes.enableMaxLock).toHaveBeenCalledWith(signer, 7);
    await expect(split(ctx, { positionId: 8, amount: '50' })).resolves.toEqual({ hash: 'split-hash' });
    expect(pools.splitStake).toHaveBeenCalledWith(signer, 8, 50n * 10n ** 18n);
    expect(pools.positionPowerSegmentAt).toHaveBeenCalledWith(7, 3);
    expect(pools.positionWithdrawableEpoch).not.toHaveBeenCalled();
  });

  it('disables a scheduled max lock at the next epoch', async () => {
    const { ctx, pools, writes } = pendingFixture();
    pools.positionPowerSegmentAt.mockResolvedValue({ normalEndEpoch: 0, maxLockPower: 10400n, nextChangeEpoch: 0 });
    await expect(maxLock(ctx, { positionId: 7, enable: false })).resolves.toEqual({ hash: 'disable-hash' });
    expect(writes.disableMaxLock).toHaveBeenCalledOnce();
  });

  it('simulates full merge compatibility before asking the wallet', async () => {
    const { ctx, call, writes, pools } = pendingFixture();
    await expect(merge(ctx, { positionIds: [7, 8] })).resolves.toEqual({ hash: 'merge-hash' });
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ from: ctx.address, to: ctx.address, data: expect.stringMatching(/^0x/) }));
    expect(call.mock.invocationCallOrder[0]).toBeLessThan(writes.mergeStakes.mock.invocationCallOrder[0]!);
    expect(pools.positionWithdrawableEpoch).not.toHaveBeenCalled();
  });

  it('rejects incompatible underlying starts even when displayed ends match', async () => {
    const { ctx, call, writes } = pendingFixture();
    call.mockRejectedValueOnce(Object.assign(new Error('InvalidValue: different normal start checkpoints'), { code: 'CALL_EXCEPTION' }));
    await expect(merge(ctx, { positionIds: [7, 8] })).rejects.toThrow('same effective lock start and end');
    expect(writes.mergeStakes).not.toHaveBeenCalled();
  });

  it('does not misreport an RPC failure as incompatible lock terms', async () => {
    const { ctx, call, writes } = pendingFixture();
    call.mockRejectedValueOnce(new Error('RPC unavailable'));
    await expect(merge(ctx, { positionIds: [7, 8] })).rejects.toThrow('reliable RPC result');
    expect(writes.mergeStakes).not.toHaveBeenCalled();
  });

  it('uses the latest activation for all merge sources', async () => {
    const { ctx, pools } = pendingFixture();
    const base = await pools.positionsBatch([7, 8]);
    pools.positionsBatch.mockResolvedValueOnce(base.map(position => ({ ...position, stakeStartEpoch: position.id === 8 ? 5 : 3 })));
    await merge(ctx, { positionIds: [7, 8] });
    expect(pools.positionPowerSegmentAt).toHaveBeenCalledWith(7, 5);
    expect(pools.positionPowerSegmentAt).toHaveBeenCalledWith(8, 5);
  });

  it('does not schedule max lock before a delayed activation', async () => {
    const { ctx, pools, writes } = pendingFixture();
    const base = await pools.positionsBatch([7]);
    pools.positionsBatch.mockResolvedValueOnce(base.map(position => ({ ...position, stakeStartEpoch: 5 })));
    await expect(maxLock(ctx, { positionId: 7, enable: true })).rejects.toThrow('activation epoch 5');
    expect(writes.enableMaxLock).not.toHaveBeenCalled();
  });

  it('preserves withdrawal blocking before replacement activation', async () => {
    const { ctx, call, writes } = pendingFixture();
    await expect(previewWithdraw(ctx, [7])).rejects.toThrow('changed this epoch');
    await expect(withdraw(ctx, { positionIds: [7], acceptSlashing: true })).rejects.toThrow('changed this epoch');
    expect(call).not.toHaveBeenCalled();
    expect(writes.withdrawStakes).not.toHaveBeenCalled();
  });

  it('preserves the contract withdrawal barrier for a scheduled lock change', async () => {
    const { ctx, pools, call, writes } = pendingFixture();
    pools.positionWithdrawableEpoch.mockResolvedValue(0);
    Object.assign(pools, { earlyExitSlashBps: async () => 0 });
    Object.assign(ctx, { poolRewards: () => null, antsToken: () => ({ canTransfer: async () => true }) });
    call.mockRejectedValue(new Error('PositionChangePending'));
    await expect(withdraw(ctx, { positionIds: [7], acceptSlashing: true })).rejects.toThrow('Withdrawal cannot execute: PositionChangePending');
    expect(writes.withdrawStakes).not.toHaveBeenCalled();
  });

  it('extends from the effective checkpoint and caps at the contract maximum', async () => {
    const { ctx, pools, writes, signer } = pendingFixture();
    pools.positionPowerSegmentAt.mockResolvedValue({ normalEndEpoch: 100, maxLockPower: 0n, nextChangeEpoch: 0 });
    const report = vi.fn();
    await expect(extend(ctx, { positionId: 7, epochs: 20 }, report)).resolves.toEqual({ hash: 'extend-hash' });
    expect(writes.extendLock).toHaveBeenCalledWith(signer, 7, 20);
    expect(report).toHaveBeenCalledWith('Extending position 7 by 7 epoch(s) to epoch 107');
  });

  it('rejects expired and already maximum extensions before submission', async () => {
    const { ctx, pools, writes } = pendingFixture();
    await expect(extend(ctx, { positionId: 7, epochs: 1 })).rejects.toThrow('maximum lock');
    pools.positionPowerSegmentAt.mockResolvedValue({ normalEndEpoch: 3, maxLockPower: 0n, nextChangeEpoch: 0 });
    await expect(extend(ctx, { positionId: 7, epochs: 1 })).rejects.toThrow('remaining lock');
    expect(writes.extendLock).not.toHaveBeenCalled();
  });

  it('keeps invalid split amounts, dust weights, ownership and closed-position checks', async () => {
    const { ctx, pools } = pendingFixture();
    await expect(split(ctx, { positionId: 7, amount: '100' })).rejects.toThrow('below');
    await expect(split(ctx, { positionId: 7, amount: '-1' })).rejects.toThrow();
    const base = await pools.positionsBatch([7]);
    pools.positionsBatch.mockResolvedValueOnce(base.map(position => ({ ...position, weightAmount: 1n })));
    await expect(split(ctx, { positionId: 7, amount: '50' })).rejects.toThrow('non-zero weight');
    pools.positionsBatch.mockResolvedValueOnce(base.map(position => ({ ...position, closedAtEpoch: 3 })));
    await expect(split(ctx, { positionId: 7, amount: '50' })).rejects.toThrow('closed');
    pools.positionsBatch.mockResolvedValueOnce(base.map(position => ({ ...position, owner: '0x0000000000000000000000000000000000000002' })));
    await expect(split(ctx, { positionId: 7, amount: '50' })).rejects.toThrow();
    expect(pools.splitStake).not.toHaveBeenCalled();
  });
});
