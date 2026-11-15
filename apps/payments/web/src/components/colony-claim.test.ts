import { describe, expect, it } from 'vitest';
import type { ColonyState } from '../api';
import { colonyAntsToClaim, colonyClaimable } from './colony-claim';

describe('colonyAntsToClaim', () => {
  it('fails rather than claim nothing when the refresh after the emissions pull failed', () => {
    expect(() => colonyAntsToClaim(null)).toThrow(/Choose Claim again/);
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
