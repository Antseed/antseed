import { describe, expect, it } from 'vitest';
import { advertisesTeeSupport, normalizeAdvertisedVerifierIds, parseVerifierCapabilities } from './verifier-capabilities.js';

describe('advertised verifier capabilities', () => {
  it('preserves supported/default semantics and deduplicates normalized IDs', () => {
    expect(parseVerifierCapabilities([
      'verifier.antseed-verifier', 'verifier-default.ANTSEED-VERIFIER',
      'verifier.acme', 'verifier-default.acme', 'verifier.antseed-verifier',
    ])).toEqual({ supported: ['antseed-verifier', 'acme'], default: 'acme' });
  });

  it('ignores malformed and missing metadata', () => {
    for (const value of [undefined, null, {}, 'verifier.antseed-verifier']) {
      expect(parseVerifierCapabilities(value)).toEqual({ supported: [] });
      expect(normalizeAdvertisedVerifierIds(value)).toEqual([]);
    }
    expect(parseVerifierCapabilities([
      null, 1, {}, 'verifier.', 'verifier.@scope/package', 'verifier.has space',
      'verification.response-auth.v1', 'antseed-verifier',
    ])).toEqual({ supported: [] });
  });

  it('recognizes only the supported TEE verifier, not arbitrary verifiers', () => {
    expect(normalizeAdvertisedVerifierIds([' Antseed-Verifier ', 'antseed-verifier', null, 'bad id']))
      .toEqual(['antseed-verifier']);
    expect(advertisesTeeSupport({ advertisedVerifierIds: ['antseed-verifier'] })).toBe(true);
    expect(advertisesTeeSupport({ advertisedVerifierIds: ['tee', 'acme', 'antseed-verifier-evil'] })).toBe(false);
    expect(advertisesTeeSupport({})).toBe(false);
  });
});
