import { describe, expect, it } from 'vitest';
import { passedSellerNodeClaims, isFreshSellerNodeEvidence, TEE_REQUIRED_CLAIMS, type TeeEvidence } from './tee-status.js';

describe('seller-node TEE evidence', () => {
  const claims = TEE_REQUIRED_CLAIMS.map((claim) => ({ claim, ok: true }));
  it('requires both claims and rejects missing, unrelated and conflicting duplicate claims', () => {
    expect(passedSellerNodeClaims(claims)).toBe(true);
    expect(passedSellerNodeClaims([...claims, claims[0]!])).toBe(true);
    expect(passedSellerNodeClaims([])).toBe(false);
    expect(passedSellerNodeClaims(claims.slice(1))).toBe(false);
    expect(passedSellerNodeClaims([{ claim: 'inference-verified', ok: true }])).toBe(false);
    expect(passedSellerNodeClaims([...claims, { ...claims[0]!, ok: false }])).toBe(false);
  });
  it('accepts only fresh successful evidence that is neither checking nor unavailable', () => {
    const evidence: TeeEvidence = { peerId: 'seller', verifierId: 'antseed-verifier', fingerprint: 'caps', checkedAt: 100, expiresAt: 200, sellerNodeVerified: true, claims };
    expect(isFreshSellerNodeEvidence(undefined, 100)).toBe(false);
    expect(isFreshSellerNodeEvidence(evidence, 199)).toBe(true);
    expect(isFreshSellerNodeEvidence(evidence, 200)).toBe(false);
    expect(isFreshSellerNodeEvidence({ ...evidence, sellerNodeVerified: false }, 150)).toBe(false);
    expect(isFreshSellerNodeEvidence({ ...evidence, unavailable: true }, 150)).toBe(false);
    expect(isFreshSellerNodeEvidence({ ...evidence, checking: true }, 150)).toBe(false);
  });
});
