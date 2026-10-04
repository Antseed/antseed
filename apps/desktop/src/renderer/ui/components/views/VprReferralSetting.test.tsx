import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { VprReferralSetting } from './VprPreferencesView';

const REFERRER = '0x1111111111111111111111111111111111111111';
const base = { configured: true, referrer: null, invite: null } as const;

it('shows a bound inviter as final', () => {
  const html = renderToStaticMarkup(<VprReferralSetting status={{ ...base, state: 'bound', referrer: REFERRER }} />);
  expect(html).toContain('Referral');
  expect(html).toContain('Invited by');
  expect(html).toContain(`title="${REFERRER}"`);
  expect(html).toContain('0x1111...1111');
  expect(html).toContain('Bound on-chain.');
  expect(html).not.toContain('Invite code');
});

it('shows a redeemed invite as pending its first paid or free request', () => {
  const html = renderToStaticMarkup(<VprReferralSetting status={{ ...base, state: 'invited', referrer: REFERRER, invite: 'abc' }} />);
  expect(html).toContain('0x1111...1111');
  expect(html).toContain('Pending. Binds with your first paid or free request.');
});

it('offers the invite field when there is no inviter', () => {
  const html = renderToStaticMarkup(<VprReferralSetting status={{ ...base, state: 'none' }} />);
  expect(html).toContain('Invite code');
  expect(html).toContain('Have an invite? Get 12 weeks of bonus $ANTS');
  expect(html).toContain('Use invite');
});

it('is hidden until the status loads and on networks without referrals', () => {
  expect(renderToStaticMarkup(<VprReferralSetting status={null} />)).toBe('');
  expect(renderToStaticMarkup(<VprReferralSetting status={{ ...base, configured: false, state: 'none' }} />)).toBe('');
});
