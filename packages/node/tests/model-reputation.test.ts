import { describe, expect, it } from 'vitest';
import {
  compareEffectiveModelReputation,
  effectiveModelReputationScore,
  normalizedModelReputationScore,
} from '../src/reputation/model-reputation.js';

describe('model reputation', () => {
  it('prefers the buyer trust score over the seller-reported score', () => {
    expect(normalizedModelReputationScore({ reputationScore: 100, onChainReputationScore: 78.4 })).toBe(78.4);
    expect(normalizedModelReputationScore({ reputationScore: 55 })).toBe(55);
    expect(normalizedModelReputationScore({})).toBeNull();
  });

  it('penalizes missing cached-input pricing only when the model supports it', () => {
    expect(effectiveModelReputationScore(100, false, true)).toBe(50);
    expect(effectiveModelReputationScore(100, false, false)).toBe(100);
  });

  it('never penalizes a free offer for omitting cached-input pricing', () => {
    expect(effectiveModelReputationScore(100, false, true, true)).toBe(100);
    expect(effectiveModelReputationScore(null, false, true, true)).toBeNull();
  });

  it('sorts by effective model reputation', () => {
    const offers = [
      { peerId: 'flash', effectiveReputationScore: 50 },
      { peerId: 'venice', effectiveReputationScore: 98.3 },
      { peerId: 'apex', effectiveReputationScore: 78.4 },
    ];
    expect(offers.sort(compareEffectiveModelReputation).map((offer) => offer.peerId))
      .toEqual(['venice', 'apex', 'flash']);
  });
});
