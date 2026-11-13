import { describe, expect, it } from 'vitest';
import { modelRouteTotalPrice } from '../src/routing/model-route-ranking.js';

describe('modelRouteTotalPrice', () => {
  it('prices a speech route by its character price, free distinct from unknown', () => {
    expect(modelRouteTotalPrice({ peerId: 'a', speechUsdPerCharacter: 0.00001 })).toBe(0.00001);
    expect(modelRouteTotalPrice({ peerId: 'a', speechUsdPerCharacter: 0, inputUsdPerMillion: null })).toBe(0);
    // Not advertised: unknown, not free.
    expect(modelRouteTotalPrice({ peerId: 'a', speechUsdPerCharacter: null })).toBeNull();
    expect(modelRouteTotalPrice({ peerId: 'a', inputUsdPerMillion: 1, outputUsdPerMillion: 2 })).toBe(3);
  });
});
