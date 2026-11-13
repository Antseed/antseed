import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PoolVerification } from '../../src/api-types';
import { VerificationLine, formatPointsMultiplier, verificationSummary } from './components/VerificationLine';

const verification = (overrides: Partial<PoolVerification> = {}): PoolVerification => ({
  sameCount: 6, diffCount: 1, pointsMultiplierBps: 10_800,
  sameServices: [{ service: 'model-a', url: 'https://scan/verification-service/1~0xaa' }],
  diffServices: [{ service: 'model-b', url: 'https://scan/verification-service/1~0xbb' }],
  ...overrides,
});

describe('verification line', () => {
  it('summarises counts and the points multiplier', () => {
    expect(verificationSummary(verification())).toBe('6 verified, 1 DIFF · points 108%');
    expect(verificationSummary(verification({ diffCount: 0, diffServices: [] }))).toBe('6 verified · points 108%');
    expect(verificationSummary(verification({ pointsMultiplierBps: null }))).toBe('6 verified, 1 DIFF');
    expect(verificationSummary(verification({ sameCount: 0, diffCount: 3, pointsMultiplierBps: 6_400 }))).toBe('3 DIFF · points 64%');
    expect(formatPointsMultiplier(10_050)).toBe('100.5%');
    expect(formatPointsMultiplier(0)).toBe('0%');
  });

  it('links each DIFF service to its audit and uses the amber dot', () => {
    const html = renderToStaticMarkup(createElement(VerificationLine, { verification: verification() }));
    expect(html).toContain('verification-line--amber');
    expect(html).toContain('Model checks: 6 verified, 1 DIFF · points 108%');
    expect(html).toContain('href="https://scan/verification-service/1~0xbb"');
    expect(html).toContain('View audit');
  });

  it('is green without a DIFF and renders nothing without verdicts', () => {
    const neutral = renderToStaticMarkup(createElement(VerificationLine, { verification: verification({ diffCount: 0, diffServices: [] }), compact: true }));
    expect(neutral).toContain('verification-line--green');
    expect(neutral).not.toContain('<a ');
    expect(renderToStaticMarkup(createElement(VerificationLine, { verification: verification({ sameCount: 0, diffCount: 0 }) }))).toBe('');
    expect(renderToStaticMarkup(createElement(VerificationLine, { verification: undefined }))).toBe('');
  });
});
