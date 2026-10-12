import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TEE_BADGE_MAX_AGE_MS, TEE_MAX_AGE_MS, type TeeEvidence } from '@antseed/node/tee-status';
import { VprTeeStatus } from './VprTeeStatus';
import modelRowStyles from './VprModelRows.module.scss';
import kitStyles from './VprKit.module.scss';

vi.mock('../InfoTooltip', () => ({ InfoTooltip: ({ content, children, align }: { content: ReactNode; children: ReactNode; align?: 'left' | 'right' }) => <div data-tooltip-align={align}>{children}{content}</div> }));

const evidence: TeeEvidence = { peerId: 'seller', verifierId: 'antseed-verifier', fingerprint: 'caps', checkedAt: 100, expiresAt: 200, claims: [], sellerNodeVerified: true };
const props = { now: 150, checking: false, available: true };

test('a cached seller badge remains visible for a day but disappears at expiry', () => {
  const cached = { ...evidence, expiresAt: evidence.checkedAt + TEE_BADGE_MAX_AGE_MS };
  for (const now of [evidence.checkedAt + TEE_MAX_AGE_MS, cached.expiresAt - 1]) {
    assert.match(renderToStaticMarkup(<VprTeeStatus {...props} now={now} evidence={cached} />), />TEE</);
  }
  assert.equal(renderToStaticMarkup(<VprTeeStatus {...props} now={cached.expiresAt} evidence={cached} />), '');
});

test('only a current successful check shows the TEE badge with the requested accessible tooltip', () => {
  const markup = renderToStaticMarkup(<VprTeeStatus {...props} evidence={evidence} className="seller-badge" />);
  assert.match(markup, />TEE</);
  assert.match(markup, /We use TEEs to enhance user privacy\./);
  assert.match(markup, /tabindex="0"/);
  assert.match(markup, /class="seller-badge"/);
  assert.match(markup, /data-tooltip-align="left"/);
  assert.ok(markup.includes(`class="${modelRowStyles.modelTag}"`));
  assert.ok(!markup.includes(kitStyles.badgeGreen));
  assert.doesNotMatch(markup, /Checking|Seller node verified|TEE advertised|Verification unavailable|Verification failed|Technical details|Last checked|Verify now|Recheck|<button|<details/);
});

test('absent, expired, failed, unavailable, and in-progress checks leave no badge or wrapper', () => {
  const cases = [
    { evidence: undefined },
    { now: 200 },
    { evidence: { ...evidence, sellerNodeVerified: false } },
    { evidence: { ...evidence, unavailable: true } },
    { evidence: { ...evidence, checking: true } },
    { checking: true },
    { available: false },
    { error: 'Offline' },
  ];
  for (const overrides of cases) {
    assert.equal(renderToStaticMarkup(<VprTeeStatus {...props} evidence={evidence} className="seller-badge" {...overrides} />), '');
  }
});
