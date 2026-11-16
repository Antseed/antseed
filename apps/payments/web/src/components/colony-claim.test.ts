import { describe, expect, it, vi } from 'vitest';
import type { ColonyState } from '../api';
import { claimColonyRewards, colonyAntsToClaim, colonyClaimable, type ColonyClaimCall } from './colony-claim';

describe('colonyAntsToClaim', () => {
  it('fails rather than claim nothing when the refresh after the emissions pull failed', () => {
    expect(() => colonyAntsToClaim(null)).toThrow(/Choose Claim again/);
  });

  it('fails rather than claim from the Mac app’s last read when its read of the pool failed', () => {
    const stale = { claimFresh: false, claim: { usdc: '0', ants: '5', antsEpochs: [], unpulledEpochs: [2] } } as unknown as ColonyState;
    expect(() => colonyAntsToClaim(stale)).toThrow(/Choose Claim again/);
  });

  it('claims no ANTS while the pool cannot send them yet', () => {
    const fresh = { claim: { usdc: '1', ants: '5', antsEpochs: [3], unpulledEpochs: [], workerAntsEpochs: [1], antsTransferable: false } } as unknown as ColonyState;
    expect(colonyAntsToClaim(fresh)).toEqual({ antsEpochs: [], workerAntsEpochs: [], outright: false });
  });

  it('claims the epochs the fresh read lists', () => {
    const fresh = { claim: { usdc: '0', ants: '5', antsEpochs: [3, 4], unpulledEpochs: [], workerAntsEpochs: [1] } } as unknown as ColonyState;
    expect(colonyAntsToClaim(fresh)).toEqual({ antsEpochs: [3, 4], workerAntsEpochs: [1], outright: false });
  });

  it('shows and claims what the pool owes outright a payout wallet with no weight in any epoch', () => {
    const state = { claim: { usdc: '0', ants: '5', outrightAnts: '5', antsEpochs: [], unpulledEpochs: [], workerAntsEpochs: [] } } as unknown as ColonyState;
    expect(colonyClaimable(state)).toMatchObject({ ants: 5n, nothing: false });
    expect(colonyAntsToClaim(state)).toEqual({ antsEpochs: [], workerAntsEpochs: [], outright: true });
  });

  it('keeps what the pool owes outright there while it cannot send ANTS yet', () => {
    const state = { claim: { usdc: '0', ants: '5', outrightAnts: '5', antsEpochs: [], unpulledEpochs: [1], antsTransferable: false } } as unknown as ColonyState;
    expect(colonyClaimable(state)).toMatchObject({ antsOpen: false, unpulled: [], nothing: true });
    expect(colonyAntsToClaim(state).outright).toBe(false);
  });

  it('offers a pull that credits the wallet outright though nothing is claimable yet', () => {
    const state = { claim: { usdc: '0', ants: '0', antsEpochs: [], unpulledEpochs: [2] } } as unknown as ColonyState;
    expect(colonyClaimable(state)).toMatchObject({ unpulled: [2], nothing: false });
  });
});

describe('claimColonyRewards', () => {
  const POOL = '0x2000000000000000000000000000000000000002';
  const WORKER = '0x4000000000000000000000000000000000000004';

  function state(claim: Partial<NonNullable<ColonyState['claim']>>, claimFresh?: boolean): ColonyState {
    return {
      pool: POOL, worker: WORKER, payout: '0x3000000000000000000000000000000000000003',
      claim: { usdc: '0', ants: '0', antsEpochs: [], unpulledEpochs: [], workerAntsEpochs: [], ...claim },
      ...(claimFresh === undefined ? {} : { claimFresh }),
    };
  }

  /** A wallet that sends every transaction, numbering their hashes in order. */
  function wallet(reloads: Array<ColonyState | null>) {
    const sent: ColonyClaimCall[] = [];
    const send = vi.fn(async (_pool: string, call: ColonyClaimCall) => {
      sent.push(call);
      return `0x${sent.length}` as `0x${string}`;
    });
    const reload = vi.fn(async () => reloads.shift() ?? null);
    return { sent, actions: { send, reload, onStep: () => {} } };
  }

  it('claims the USDC, pulls the pool’s ANTS and claims what the read after the pull lists', async () => {
    const { sent, actions } = wallet([state({ ants: '9', antsEpochs: [2], workerAntsEpochs: [1], outrightAnts: '4' }, true)]);
    await expect(claimColonyRewards(state({ usdc: '7', unpulledEpochs: [2] }), actions)).resolves.toBe('0x5');
    expect(sent).toEqual([
      { functionName: 'claimUsdc' },
      { functionName: 'claimEpochEmissions', args: [[2n]] },
      { functionName: 'claimAnts', args: [[2n]] },
      { functionName: 'claimAntsFor', args: [WORKER, [1n]] },
      { functionName: 'claimOwedAnts' },
    ]);
  });

  it('stops with an error to retry when the pull went through but the pool could not be read after it', async () => {
    // The Mac app answers with its last read: no claimable epoch yet, the pulled one still listed.
    const { sent, actions } = wallet([state({ unpulledEpochs: [2] }, false)]);
    await expect(claimColonyRewards(state({ unpulledEpochs: [2] }), actions)).rejects.toThrow(/Choose Claim again/);
    expect(sent).toEqual([{ functionName: 'claimEpochEmissions', args: [[2n]] }]);
  });

  it('stops the same way when the Mac app could not be reached after the pull', async () => {
    const { sent, actions } = wallet([null]);
    await expect(claimColonyRewards(state({ unpulledEpochs: [2] }), actions)).rejects.toThrow(/Choose Claim again/);
    expect(sent).toHaveLength(1);
  });

  it('reads the pool again before a claim from a page showing the Mac app’s last read', async () => {
    const { sent, actions } = wallet([state({ ants: '3', antsEpochs: [4] }, true)]);
    await expect(claimColonyRewards(state({ usdc: '7', ants: '3', antsEpochs: [3] }, false), actions)).resolves.toBe('0x1');
    expect(sent).toEqual([{ functionName: 'claimAnts', args: [[4n]] }]);
  });

  it('sends nothing while the pool still cannot be read', async () => {
    const { sent, actions } = wallet([state({ usdc: '7' }, false)]);
    await expect(claimColonyRewards(state({ usdc: '7' }, false), actions)).rejects.toThrow(/Choose Claim again/);
    expect(sent).toEqual([]);
  });

  it('claims what there is when a pull fails, and has nothing to report when nothing was sent', async () => {
    const pulled = wallet([state({ ants: '3', antsEpochs: [1] })]);
    pulled.actions.send.mockRejectedValueOnce(new Error('reward locked'));
    await expect(claimColonyRewards(state({ ants: '3', antsEpochs: [1], unpulledEpochs: [2] }), pulled.actions)).resolves.toBe('0x1');
    expect(pulled.sent).toEqual([{ functionName: 'claimAnts', args: [[1n]] }]);

    const nothing = wallet([]);
    await expect(claimColonyRewards(state({}), nothing.actions)).rejects.toThrow('Nothing to claim yet.');
    expect(nothing.actions.reload).not.toHaveBeenCalled();
  });
});
