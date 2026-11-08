import { describe, expect, it } from 'vitest';
import {
  VERIFICATION_STATUS_STALE_MAX_MS,
  DIFF_VERIFICATION_REPUTATION_MULTIPLIER,
  compareEffectiveModelReputation,
  effectiveModelReputationScore,
  hasLiveDiffVerdict,
  normalizedModelReputationScore,
  rotateEqualReputationHead,
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
    const peer = { onChainDiffServices: ['gpt-6.1-sol'], onChainVerificationFetchedAt: Date.now() };
    expect(verificationServiceKey('  GPT-6.1-Sol ')).toBe('gpt-6.1-sol');
    expect(hasLiveDiffVerdict(peer, 'GPT-6.1-Sol')).toBe(true);
    expect(hasLiveDiffVerdict(peer, 'claude-opus-5.5')).toBe(false);
    // A differently spelled alias is a different service on-chain.
    expect(hasLiveDiffVerdict(peer, 'gpt-6-1-sol')).toBe(false);
    expect(hasLiveDiffVerdict({}, 'gpt-6.1-sol')).toBe(false);
    expect(hasLiveDiffVerdict(undefined, 'gpt-6.1-sol')).toBe(false);
  });

  it('fails open on a DIFF list from a read older than 15 minutes or of unknown age', () => {
    const now = 1_700_000_000_000;
    const fresh = { onChainDiffServices: ['gpt-6.1-sol'], onChainVerificationFetchedAt: now - VERIFICATION_STATUS_STALE_MAX_MS + 1 };
    expect(hasLiveDiffVerdict(fresh, 'gpt-6.1-sol', now)).toBe(true);
    // A list carried forward or restored from saved state while the contract could not be read.
    const stale = { ...fresh, onChainVerificationFetchedAt: now - VERIFICATION_STATUS_STALE_MAX_MS };
    expect(hasLiveDiffVerdict(stale, 'gpt-6.1-sol', now)).toBe(false);
    expect(hasLiveDiffVerdict({ onChainDiffServices: ['gpt-6.1-sol'] }, 'gpt-6.1-sol', now)).toBe(false);
    expect(hasLiveDiffVerdict({ onChainDiffServices: ['gpt-6.1-sol'], onChainVerificationFetchedAt: null }, 'gpt-6.1-sol', now)).toBe(false);
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

  it('rotates a reputation tie and leaves a higher score in front', () => {
    const alpha = { peerId: 'a', effectiveReputationScore: 80 };
    const beta = { peerId: 'b', effectiveReputationScore: 80 };
    const tied = [alpha, beta].sort(compareEffectiveModelReputation);
    const first = rotateEqualReputationHead([...tied]).map((offer) => offer.peerId);
    const second = rotateEqualReputationHead([...tied]).map((offer) => offer.peerId);
    expect(new Set([first[0], second[0]])).toEqual(new Set(['a', 'b']));
    expect(first[1]).not.toBe(first[0]);

    const ahead = { peerId: 'a', effectiveReputationScore: 90 };
    const ordered = [beta, ahead].sort(compareEffectiveModelReputation);
    const picks = Array.from({ length: 4 }, () => rotateEqualReputationHead([...ordered])[0]?.peerId);
    expect(picks).toEqual(['a', 'a', 'a', 'a']);
  });

  it('returns an empty reputation list unchanged', () => {
    expect(rotateEqualReputationHead([])).toEqual([]);
  });
});
