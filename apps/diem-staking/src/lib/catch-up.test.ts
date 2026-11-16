import { describe, expect, it, vi } from 'vitest';

import {
  CatchUpRevertedError,
  CatchUpUnconfirmedError,
  MAX_CATCH_UP_EPOCHS_PER_TX,
  planCatchUp,
  submitCatchUp,
  type CatchUpDeps,
} from './catch-up';

const CAP = 16;
const HASH = `0x${'ab'.repeat(32)}` as const;

describe('planCatchUp', () => {
  it('needs nothing at the cap', () => {
    expect(planCatchUp({ cap: CAP, poolBehind: 0, userBehind: CAP, hasStake: true })).toEqual({ status: 'none' });
    expect(planCatchUp({ cap: CAP, poolBehind: 6, userBehind: 10, hasStake: true })).toEqual({ status: 'none' });
  });

  it('catches up a staked wallet one past the cap', () => {
    expect(planCatchUp({ cap: CAP, poolBehind: 0, userBehind: CAP + 1, hasStake: true })).toEqual({
      status: 'needed', kind: 'user', epochsBehind: 17, epochsThisTx: 17,
    });
  });

  it('counts the pool and wallet backlog together when each is under the cap', () => {
    expect(planCatchUp({ cap: CAP, poolBehind: 10, userBehind: 10, hasStake: true })).toEqual({
      status: 'needed', kind: 'user', epochsBehind: 20, epochsThisTx: 20,
    });
  });

  it('uses catchUpPoints for a staked wallet even when only the pool is behind', () => {
    expect(planCatchUp({ cap: CAP, poolBehind: 20, userBehind: 0, hasStake: true })).toMatchObject({
      status: 'needed', kind: 'user', epochsBehind: 20,
    });
  });

  it('ignores the wallet backlog without a stake and syncs only the pool', () => {
    expect(planCatchUp({ cap: CAP, poolBehind: 5, userBehind: 40, hasStake: false })).toEqual({ status: 'none' });
    expect(planCatchUp({ cap: CAP, poolBehind: 17, userBehind: 40, hasStake: false })).toEqual({
      status: 'needed', kind: 'pool', epochsBehind: 17, epochsThisTx: 17,
    });
  });

  it('splits a long backlog into batches until it is under the cap', () => {
    let userBehind = 130;
    const batches: number[] = [];
    for (;;) {
      const plan = planCatchUp({ cap: CAP, poolBehind: 0, userBehind, hasStake: true });
      if (plan.status === 'none') break;
      expect(plan.epochsThisTx).toBeLessThanOrEqual(MAX_CATCH_UP_EPOCHS_PER_TX);
      batches.push(plan.epochsThisTx);
      userBehind -= plan.epochsThisTx;
    }
    expect(batches).toEqual([48, 48, 34]);
    expect(userBehind).toBe(0);
  });
});

function deps(overrides: Partial<CatchUpDeps> = {}): CatchUpDeps & { order: string[] } {
  const order: string[] = [];
  return {
    order,
    ensureNetwork: vi.fn(async () => { order.push('network'); }),
    submit: vi.fn(async () => { order.push('submit'); return HASH; }),
    waitForReceipt: vi.fn(async () => { order.push('receipt'); return { status: 'success' as const }; }),
    onConfirming: vi.fn((c: boolean) => { order.push(c ? 'confirming' : 'confirmed'); }),
    ...overrides,
  };
}

describe('submitCatchUp', () => {
  it('switches network, submits, and stays confirming until the receipt', async () => {
    const d = deps();
    await expect(submitCatchUp(d, 'user', 22)).resolves.toBe(HASH);
    expect(d.submit).toHaveBeenCalledWith('user', 22);
    expect(d.order).toEqual(['network', 'submit', 'confirming', 'receipt', 'confirmed']);
  });

  it('throws when the network switch fails and submits nothing', async () => {
    const d = deps({ ensureNetwork: vi.fn(async () => { throw new Error('User rejected the chain switch'); }) });
    await expect(submitCatchUp(d, 'user', 22)).rejects.toThrow('User rejected the chain switch');
    expect(d.submit).not.toHaveBeenCalled();
  });

  it('throws a reverted error for a failed receipt', async () => {
    const d = deps({ waitForReceipt: vi.fn(async () => ({ status: 'reverted' as const })) });
    await expect(submitCatchUp(d, 'pool', 17)).rejects.toBeInstanceOf(CatchUpRevertedError);
    expect(d.onConfirming).toHaveBeenLastCalledWith(false);
  });

  it('throws an unconfirmed error with the hash when the receipt cannot be read', async () => {
    const d = deps({ waitForReceipt: vi.fn(async () => { throw new Error('timeout'); }) });
    const err = await submitCatchUp(d, 'user', 22).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CatchUpUnconfirmedError);
    expect((err as CatchUpUnconfirmedError).hash).toBe(HASH);
    expect(d.onConfirming).toHaveBeenLastCalledWith(false);
  });
});
