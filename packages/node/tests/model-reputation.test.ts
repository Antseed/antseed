import { describe, expect, it } from 'vitest';
import {
  DIFF_VERIFICATION_REPUTATION_MULTIPLIER,
  compareEffectiveModelReputation,
  effectiveModelReputationScore,
  hasLiveDiffVerdict,
  normalizedModelReputationScore,
  verificationServiceKey,
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

  it('keeps 10% of the reputation for a service with a live DIFF verdict', () => {
    expect(DIFF_VERIFICATION_REPUTATION_MULTIPLIER).toBe(0.1);
    expect(effectiveModelReputationScore(80, true, true, false, true)).toBeCloseTo(8);
    expect(effectiveModelReputationScore(80, false, false, false, true)).toBeCloseTo(8);
  });

  it('applies the DIFF penalty to free offers too', () => {
    expect(effectiveModelReputationScore(100, false, true, true, true)).toBeCloseTo(10);
  });

  it('compounds the DIFF and missing cached-input penalties', () => {
    expect(effectiveModelReputationScore(100, false, true, false, true)).toBeCloseTo(5);
  });

  it('leaves missing reputation null with a DIFF verdict', () => {
    expect(effectiveModelReputationScore(null, false, true, false, true)).toBeNull();
  });

  it('matches DIFF verdicts per service, the way the contract hashes names', () => {
    const peer = { onChainDiffServices: ['gpt-6.1-sol'] };
    expect(verificationServiceKey('  GPT-6.1-Sol ')).toBe('gpt-6.1-sol');
    expect(hasLiveDiffVerdict(peer, 'GPT-6.1-Sol')).toBe(true);
    expect(hasLiveDiffVerdict(peer, 'claude-opus-5.5')).toBe(false);
    // A differently spelled alias is a different service on-chain.
    expect(hasLiveDiffVerdict(peer, 'gpt-6-1-sol')).toBe(false);
    expect(hasLiveDiffVerdict({}, 'gpt-6.1-sol')).toBe(false);
    expect(hasLiveDiffVerdict(undefined, 'gpt-6.1-sol')).toBe(false);
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
