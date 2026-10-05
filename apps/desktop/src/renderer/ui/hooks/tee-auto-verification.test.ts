import { describe, expect, it } from 'vitest';
import { TEE_BADGE_MAX_AGE_MS, TEE_MAX_AGE_MS, type TeeEvidence, type TeeSnapshot } from '@antseed/node/tee-status';
import { TeeAutoVerification } from './tee-auto-verification';

const peer = { peerId: 'seller', advertisedVerifierIds: ['antseed-verifier'] };
const snapshot: TeeSnapshot = { sessionId: 'buyer', verificationEnabled: true, evidence: [] };
const verdict: TeeEvidence = { peerId: 'seller', verifierId: 'antseed-verifier', fingerprint: 'caps', checkedAt: 0, expiresAt: 300_000, sellerNodeVerified: true, claims: [] };

describe('automatic TEE checks', () => {
  it('rechecks when the buyer invalidates cached evidence without changing advertised IDs', () => {
    const automatic = new TeeAutoVerification();
    automatic.update([peer]);
    const status = { ...snapshot, evidence: [{ ...verdict, expiresAt: TEE_BADGE_MAX_AGE_MS }] };
    expect(automatic.next(status, new Set(['seller']), 0)).toBeUndefined();
    expect(automatic.next(snapshot, new Set(['seller']), 2000)?.peerId).toBe('seller');
  });

  it('preserves transient retry backoff when unavailable evidence disappears', () => {
    const automatic = new TeeAutoVerification();
    automatic.update([peer]);
    const attempt = automatic.next(snapshot, new Set(['seller']), 0)!;
    automatic.complete(attempt, { ...verdict, unavailable: true, sellerNodeVerified: false }, 0);
    expect(automatic.next(snapshot, new Set(['seller']), 2000)).toBeUndefined();
    expect(automatic.next(snapshot, new Set(['seller']), 30_000)?.peerId).toBe('seller');
  });

  it('reuses a day-long badge until expiry while viewing a seller', () => {
    const automatic = new TeeAutoVerification();
    automatic.update([peer]);
    const status = { ...snapshot, evidence: [{ ...verdict, expiresAt: TEE_BADGE_MAX_AGE_MS }] };
    expect(automatic.next(status, new Set(['seller']), TEE_MAX_AGE_MS)).toBeUndefined();
    expect(automatic.next(status, new Set(['seller']), TEE_BADGE_MAX_AGE_MS - 1)).toBeUndefined();
    expect(automatic.next(status, new Set(['seller']), TEE_BADGE_MAX_AGE_MS)?.peerId).toBe('seller');
  });

  it('replaces the day-long retry deadline when routing reports a newer failed check', () => {
    const automatic = new TeeAutoVerification();
    automatic.update([peer]);
    const success = { ...snapshot, evidence: [{ ...verdict, expiresAt: TEE_BADGE_MAX_AGE_MS }] };
    expect(automatic.next(success, new Set(['seller']), 0)).toBeUndefined();
    const failed = { ...snapshot, evidence: [{ ...verdict, checkedAt: TEE_MAX_AGE_MS, expiresAt: 2 * TEE_MAX_AGE_MS, sellerNodeVerified: false }] };
    expect(automatic.next(failed, new Set(['seller']), TEE_MAX_AGE_MS)).toBeUndefined();
    expect(automatic.next(failed, new Set(['seller']), 2 * TEE_MAX_AGE_MS)?.peerId).toBe('seller');
  });

  it('backs off and retries a newer unavailable routing check rather than waiting a day', () => {
    const automatic = new TeeAutoVerification();
    automatic.update([peer]);
    const success = { ...snapshot, evidence: [{ ...verdict, expiresAt: TEE_BADGE_MAX_AGE_MS }] };
    expect(automatic.next(success, new Set(), 0)).toBeUndefined();
    const unavailable = { ...snapshot, evidence: [{ ...verdict, checkedAt: TEE_MAX_AGE_MS, unavailable: true, sellerNodeVerified: false }] };
    expect(automatic.next(unavailable, new Set(), TEE_MAX_AGE_MS)).toBeUndefined();
    expect(automatic.next(unavailable, new Set(), TEE_MAX_AGE_MS + 29_999)).toBeUndefined();
    expect(automatic.next(unavailable, new Set(), TEE_MAX_AGE_MS + 30_000)?.peerId).toBe('seller');
  });

  it('checks distinct advertising peers once, including new sellers, without changing inputs', () => {
    const automatic = new TeeAutoVerification();
    const peers = [peer, peer, { peerId: 'other', advertisedVerifierIds: ['unrelated'] }, { peerId: 'missing' }];
    const original = structuredClone({ peers, snapshot });
    automatic.update(peers);
    const attempt = automatic.next(snapshot, new Set(), 0)!;
    expect(attempt.peerId).toBe('seller');
    automatic.complete(attempt, verdict, 0);
    const status = { ...snapshot, evidence: [verdict] };
    expect(automatic.next(status, new Set(), 400_000)).toBeUndefined();
    automatic.update([...peers, { ...peer, peerId: 'new' }]);
    expect(automatic.next(status, new Set(), 400_000)?.peerId).toBe('new');
    expect({ peers, snapshot }).toEqual(original);
  });

  it('reuses fresh evidence and refreshes expired evidence only for interested sellers', () => {
    const automatic = new TeeAutoVerification();
    automatic.update([peer]);
    const status = { ...snapshot, evidence: [verdict] };
    expect(automatic.next(status, new Set(['seller']), 299_999)).toBeUndefined();
    expect(automatic.next(status, new Set(), 300_000)).toBeUndefined();
    expect(automatic.next(status, new Set(['seller']), 300_000)?.peerId).toBe('seller');
  });

  it('backs off transient errors and stops after three inactive attempts', () => {
    const automatic = new TeeAutoVerification();
    automatic.update([peer]);
    let attempt = automatic.next(snapshot, new Set(), 0)!;
    automatic.complete(attempt, { ...verdict, unavailable: true, sellerNodeVerified: false }, 0);
    expect(automatic.next(snapshot, new Set(), 29_999)).toBeUndefined();
    attempt = automatic.next(snapshot, new Set(), 30_000)!;
    automatic.complete(attempt, undefined, 30_000);
    expect(automatic.next(snapshot, new Set(), 89_999)).toBeUndefined();
    attempt = automatic.next(snapshot, new Set(), 90_000)!;
    automatic.complete(attempt, undefined, 90_000);
    expect(automatic.next(snapshot, new Set(), 500_000)).toBeUndefined();
    expect(automatic.next(snapshot, new Set(['seller']), 500_000)?.peerId).toBe('seller');
  });

  it('does not repeatedly retry failed attestation while browsing before expiry', () => {
    const automatic = new TeeAutoVerification();
    automatic.update([peer]);
    const attempt = automatic.next(snapshot, new Set(['seller']), 0)!;
    const failure = { ...verdict, sellerNodeVerified: false };
    const status = { ...snapshot, evidence: [failure] };
    automatic.complete(attempt, failure, 0);
    expect(automatic.next(status, new Set(['seller']), 2000)).toBeUndefined();
    expect(automatic.next(status, new Set(['seller']), 300_000)?.peerId).toBe('seller');
  });

  it('clears background retry history when request-time verification supplies fresh evidence', () => {
    const automatic = new TeeAutoVerification();
    automatic.update([peer]);
    const attempt = automatic.next(snapshot, new Set(), 0)!;
    automatic.complete(attempt, undefined, 0);
    const status = { ...snapshot, evidence: [verdict] };
    expect(automatic.next(status, new Set(), 1000)).toBeUndefined();
    expect(automatic.next(status, new Set(), 400_000)).toBeUndefined();
  });

  it('invalidates attempts when support disappears or the buyer session changes', () => {
    const automatic = new TeeAutoVerification();
    automatic.update([peer]);
    const old = automatic.next(snapshot, new Set(), 0)!;
    automatic.update([{ ...peer, advertisedVerifierIds: [] }]);
    expect(automatic.current(old)).toBe(false);
    expect(automatic.next(snapshot, new Set(['seller']), 3000)).toBeUndefined();
    automatic.update([peer]);
    const restored = automatic.next(snapshot, new Set(), 4000)!;
    expect(automatic.current(old)).toBe(false);
    expect(automatic.next({ ...snapshot, sessionId: 'restarted' }, new Set(), 4000)?.peerId).toBe('seller');
    expect(automatic.current(restored)).toBe(false);
  });

  it('respects disabled verification and existing in-flight checks', () => {
    const automatic = new TeeAutoVerification();
    automatic.update([peer]);
    expect(automatic.next({ ...snapshot, verificationEnabled: false }, new Set(), 0)).toBeUndefined();
    expect(automatic.next({ ...snapshot, evidence: [{ ...verdict, checking: true }] }, new Set(), 0)).toBeUndefined();
  });

  it('checks all discovered sellers once even when the buyer evicts old evidence', () => {
    const automatic = new TeeAutoVerification();
    const peers = Array.from({ length: 600 }, (_, index) => ({ ...peer, peerId: String(index) }));
    automatic.update(peers);
    const status = { ...snapshot, evidence: [] as TeeEvidence[] };
    const selected = new Set<string>();
    for (let index = 0; index < peers.length; index++) {
      const now = index * 2000;
      const attempt = automatic.next(status, new Set(), now)!;
      expect(attempt).toBeDefined();
      expect(selected.has(attempt.peerId)).toBe(false);
      selected.add(attempt.peerId);
      const evidence = { ...verdict, peerId: attempt.peerId, checkedAt: now, expiresAt: now + TEE_BADGE_MAX_AGE_MS };
      automatic.complete(attempt, evidence, now);
      status.evidence.push(evidence);
      if (status.evidence.length > 512) status.evidence.shift();
      automatic.update(peers);
    }
    expect(selected.size).toBe(600);
    expect(automatic.next(status, new Set(), 1_200_000)).toBeUndefined();
    const viewed = automatic.next(status, new Set(['0']), 1_202_000)!;
    expect(viewed.peerId).toBe('0');
    automatic.complete(viewed, { ...verdict, peerId: '0', checkedAt: 1_202_000, expiresAt: TEE_BADGE_MAX_AGE_MS }, 1_202_000);
    automatic.update([...peers, { ...peer, peerId: 'late-arrival' }]);
    expect(automatic.next(status, new Set(), 1_204_000)?.peerId).toBe('late-arrival');
  });

  it('prioritizes a viewed seller beyond 512 and preserves its backoff across discovery updates', () => {
    const automatic = new TeeAutoVerification();
    const peers = Array.from({ length: 600 }, (_, index) => ({ ...peer, peerId: String(index) }));
    automatic.update(peers);
    const interested = new Set(['599']);
    const attempt = automatic.next(snapshot, interested, 0)!;
    expect(attempt.peerId).toBe('599');
    automatic.complete(attempt, undefined, 0);
    for (const now of [2000, 10_000, 29_999]) {
      automatic.update([...peers].reverse());
      expect(automatic.current(attempt)).toBe(true);
      expect(automatic.next(snapshot, interested, now)?.peerId).not.toBe('599');
    }
    expect(automatic.next(snapshot, interested, 30_000)?.peerId).toBe('599');
    automatic.update(peers.slice(0, 599));
    expect(automatic.current(attempt)).toBe(false);
    expect(automatic.next(snapshot, interested, 60_000)?.peerId).not.toBe('599');
    automatic.update(peers);
    expect(automatic.next(snapshot, interested, 62_000)?.peerId).toBe('599');
  });
});
