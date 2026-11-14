import { describe, expect, it } from 'vitest';
import type { ColonyState } from '../api';
import { colonyAntsToClaim } from './colony-claim';

describe('colonyAntsToClaim', () => {
  it('fails rather than claim nothing when the refresh after the emissions pull failed', () => {
    expect(() => colonyAntsToClaim(null)).toThrow(/Choose Claim again/);
  });

  it('claims no ANTS while the pool cannot send them yet', () => {
    const fresh = { claim: { usdc: '1', ants: '5', antsEpochs: [3], unpulledEpochs: [], workerAntsEpochs: [1], antsTransferable: false } } as unknown as ColonyState;
    expect(colonyAntsToClaim(fresh)).toEqual({ antsEpochs: [], workerAntsEpochs: [] });
  });

  it('claims the epochs the fresh read lists', () => {
    const fresh = { claim: { usdc: '0', ants: '5', antsEpochs: [3, 4], unpulledEpochs: [], workerAntsEpochs: [1] } } as unknown as ColonyState;
    expect(colonyAntsToClaim(fresh)).toEqual({ antsEpochs: [3, 4], workerAntsEpochs: [1] });
  });
});
