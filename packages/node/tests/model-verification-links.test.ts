import { describe, expect, it } from 'vitest';
import { keccak256, toUtf8Bytes } from 'ethers';
import { computeTrustScore, hasLiveSameVerdict, liveVerificationVerdict, verificationPointsMultiplierBps, verificationServiceUrl } from '../src/index.js';

describe('verificationServiceUrl', () => {
  it('builds the explorer page of one service from its agent id and name', () => {
    expect(verificationServiceUrl('https://antscan.co/', 54037, ' Claude-Fable-5.1 '))
      .toBe(`https://antscan.co/verification-service/54037~${keccak256(toUtf8Bytes('claude-fable-5.1'))}`);
  });

  it('returns null without an explorer, a valid agent id or a service', () => {
    expect(verificationServiceUrl(undefined, 1, 'm')).toBeNull();
    expect(verificationServiceUrl('https://antscan.co', 0, 'm')).toBeNull();
    expect(verificationServiceUrl('https://antscan.co', 1, '  ')).toBeNull();
  });
});

describe('liveVerificationVerdict', () => {
  const now = 1_000_000_000;
  const source = { onChainDiffServices: ['a'], onChainSameServices: ['b'], onChainVerificationFetchedAt: now - 60_000 };

  it('reads DIFF before SAME and nothing for other services', () => {
    expect(liveVerificationVerdict(source, 'A', now)).toBe('diff');
    expect(liveVerificationVerdict(source, 'b', now)).toBe('same');
    expect(liveVerificationVerdict(source, 'c', now)).toBeNull();
  });

  it('ignores a read older than the fail-open window', () => {
    expect(hasLiveSameVerdict({ ...source, onChainVerificationFetchedAt: now - 16 * 60_000 }, 'b', now)).toBe(false);
  });
});

describe('verification multiplier in the trust score', () => {
  const now = 1_000_000_000;
  const base = {
    peerId: 'p', lastSeen: now, providers: [], onChainUsageEpoch: 22, onChainUsageShareBps: 500, onChainPoolPowerShareBps: 500,
    onChainWashFlagged: false, onChainVerificationFetchedAt: now - 60_000,
  } as any;

  it('matches the policy multiplier', () => {
    const rates = { bonusBps: 200n, penaltyBps: 400n };
    expect(verificationPointsMultiplierBps(6, 1, rates)).toBe(10_800);
    expect(verificationPointsMultiplierBps(2, 4, rates)).toBe(4_000);
    expect(verificationPointsMultiplierBps(0, 5, rates)).toBe(0);
    expect(verificationPointsMultiplierBps(30, 0, rates)).toBe(15_000);
  });

  it('scales trust by the policy multiplier, up as well as down, capped at 100', () => {
    const raw = computeTrustScore(base, now)!.score;
    const cut = computeTrustScore({ ...base, onChainVerificationStatus: { sameCount: 2, diffCount: 4, pointsMultiplierBps: 4_000 } }, now)!;
    expect(cut.score).toBeCloseTo(raw * 0.4);
    expect(cut.verification).toEqual({ multiplierBps: 4_000, sameCount: 2, diffCount: 4, change: cut.score - raw, penalty: raw - cut.score });
    const bonus = computeTrustScore({ ...base, onChainVerificationStatus: { sameCount: 10, diffCount: 0, pointsMultiplierBps: 12_000 } }, now)!;
    expect(bonus.score).toBeCloseTo(Math.min(100, raw * 1.2));
    expect(bonus.verification?.change).toBeCloseTo(bonus.score - raw);
    expect(bonus.verification?.penalty).toBe(0);
    const neutral = computeTrustScore({ ...base, onChainVerificationStatus: { sameCount: 0, diffCount: 0, pointsMultiplierBps: 10_000 } }, now)!;
    expect(neutral.score).toBe(raw);
    expect(neutral.verification).toBeNull();
    const top = { ...base, onChainUsageShareBps: 5_000, onChainPoolPowerShareBps: 5_000 };
    expect(computeTrustScore({ ...top, onChainVerificationStatus: { sameCount: 25, diffCount: 0, pointsMultiplierBps: 15_000 } }, now)!.score).toBe(100);
  });

  it('fails open on a stale read or unknown rates', () => {
    const raw = computeTrustScore(base, now)!.score;
    expect(computeTrustScore({ ...base, onChainVerificationFetchedAt: now - 16 * 60_000, onChainVerificationStatus: { sameCount: 0, diffCount: 5, pointsMultiplierBps: 0 } }, now)!.score).toBe(raw);
    expect(computeTrustScore({ ...base, onChainVerificationStatus: { sameCount: 0, diffCount: 5, pointsMultiplierBps: null } }, now)!.score).toBe(raw);
  });
});
