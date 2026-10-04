import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { receiveInviteLink } from '../InviteCodeField';
import { VprInvitesCard, VprRefereeBonusCard, VprReferralCard, VprRewardsView, pendingHeadline } from './VprRewardsView';

vi.mock('../../hooks/useActions', () => ({ useActions: () => ({ refreshPaymentSummary: vi.fn() }) }));
vi.mock('../../hooks/useUiSelector', () => ({ shallowEqual: () => true, useUiSelector: () => ({ rewards: { available: true, pendingAnts: '12', currentEpoch: 24, transfersEnabled: false }, loading: false }) }));
vi.mock('../StakingButton', () => ({ StakingButton: ({ children, page = 'stake', disabled }: { children: React.ReactNode; page?: string; disabled?: boolean }) => <button data-dashboard-page={page} disabled={disabled}>{children}</button> }));
vi.mock('../vpr/VprKit', () => ({ VprPage: ({ children }: { children: React.ReactNode }) => <main>{children}</main>, VprCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, VprBadge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>, VprSettingRow: ({ title, hint, control }: { title: string; hint?: string; control: React.ReactNode }) => <div data-row={title}>{hint}{control}</div> }));

it('opens buyer claims and staking through the shared dashboard at their respective destinations', () => {
  const html = renderToStaticMarkup(<VprRewardsView />);
  expect(html).toContain('data-dashboard-page="rewards">Claim rewards');
  expect(html).toContain('data-dashboard-page="stake">Manage staking');
});

const BUYER = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';

const TOTALS = { points: '0', ants: '0', pendingPoints: '0' };
const ALLOWANCE = { epoch: 30, quota: 5, used: 2, left: 3 };

it('lists each invited buyer with points, pending points and ANTS earned, plus a total', () => {
  const html = renderToStaticMarkup(<VprInvitesCard invites={{
    available: true,
    listed: true,
    allowance: ALLOWANCE,
    buyers: [
      { buyer: BUYER, points: '12500', ants: '3.456', pendingPoints: '0' },
      { buyer: OTHER, points: '250', ants: '0', pendingPoints: '250' },
    ],
    totals: { points: '12750', ants: '3.456', pendingPoints: '250' },
    error: null,
  }} />);
  expect(html).toContain('Your invites');
  expect(html).toContain('role="columnheader">Invited wallet');
  expect(html).toContain('role="columnheader">Earned');
  expect(html).toContain(`data-buyer="${BUYER}"`);
  expect(html).toContain('0x2222...2222');
  expect(html).toContain('12,500 pts');
  expect(html).toContain('3.46 $ANTS');
  // Usage still in an open week reads as pending, not as nothing earned.
  expect(html).toContain('250 pts · 250 pts pending');
  expect(html).toContain('0.00 $ANTS');
  expect(html).toContain('Total · 2 wallets');
  expect(html).not.toContain('No one has joined');
});

it('offers to create an invite with the invites left this week', () => {
  const html = renderToStaticMarkup(<VprInvitesCard invites={{ available: true, listed: true, allowance: ALLOWANCE, buyers: [], totals: TOTALS, error: null }} />);
  expect(html).toContain('data-row="Invite someone"');
  expect(html).toContain('3 of 5 left this week.');
  expect(html).toContain('Create link');
  expect(html).toContain('No one has joined with your invites yet.');
  expect(html).not.toContain('Total ·');
});

it('explains why there are no invites without last week\'s activity', () => {
  const html = renderToStaticMarkup(<VprInvitesCard invites={{ available: true, listed: true, allowance: { epoch: 30, quota: 0, used: 0, left: 0 }, buyers: [], totals: TOTALS, error: null }} />);
  expect(html).toContain('Invites unlock after at least 1 USDC of usage or sales in the previous week.');
  expect(html).toMatch(/disabled=""[^>]*><span class="as-button__label">Create link/);
});

it('still offers invites when no explorer lists referrals', () => {
  const html = renderToStaticMarkup(<VprInvitesCard invites={{ available: true, listed: false, allowance: null, buyers: [], totals: TOTALS, error: null }} />);
  expect(html).toContain('Create link');
  expect(html).not.toContain('No one has joined');
  expect(html).not.toContain('Invited wallet');
});

it('hides invites when referrals are not configured', () => {
  expect(renderToStaticMarkup(<VprInvitesCard invites={{ available: false, listed: false, allowance: null, buyers: [], totals: TOTALS, error: null }} />)).toBe('');
  expect(renderToStaticMarkup(<VprInvitesCard invites={null} />)).toBe('');
});

it('shows the referee bonus with weeks left and claims through the rewards dashboard', () => {
  const html = renderToStaticMarkup(<VprRefereeBonusCard bonus={{ available: true, weeksLeft: 9, payable: '4.5', claimableEpochs: [28] }} />);
  expect(html).toContain('Invite bonus');
  expect(html).toContain('4.50 $ANTS payable');
  expect(html).toContain('9 weeks left.');
  expect(html).toContain('data-dashboard-page="rewards">Claim');
  expect(renderToStaticMarkup(<VprRefereeBonusCard bonus={{ available: false, weeksLeft: null, payable: '0', claimableEpochs: [] }} />)).toBe('');
});

it('counts the invite bonus in the Pending $ANTS headline', () => {
  const bonus = { available: true, weeksLeft: 10, payable: '300', claimableEpochs: [20] };
  expect(pendingHeadline({ available: true, pendingAnts: '0' }, bonus)).toEqual({ pending: '300', bonusPayable: 300 });
  expect(pendingHeadline({ available: true, pendingAnts: '12.5' }, bonus).pending).toBe('312.5');
  expect(pendingHeadline({ available: true, pendingAnts: '12.5' }, null).pending).toBe('12.5');
  expect(pendingHeadline(null, { ...bonus, available: false }).pending).toBe('0');
});

const INVITER = '0x1111111111111111111111111111111111111111';
const REFERRAL = { configured: true, referrer: null, invite: null } as const;

it('offers "Have an invite?" on Rewards while the wallet has no inviter and no pending invite', () => {
  const html = renderToStaticMarkup(<VprReferralCard status={{ ...REFERRAL, state: 'none' }} />);
  expect(html).toContain('Have an invite? Get 12 weeks of bonus $ANTS');
  expect(html).toContain('Invite code');
  expect(html).toContain('Use invite');
  expect(html).not.toContain('Invited by');
});

it('shows the inviter instead of the field once an invite is pending or bound', () => {
  const pending = renderToStaticMarkup(<VprReferralCard status={{ ...REFERRAL, state: 'invited', referrer: INVITER, invite: 'abc' }} />);
  expect(pending).toContain('data-row="Invited by"');
  expect(pending).toContain('0x1111...1111');
  expect(pending).toContain('Pending. Binds with your first paid or free request.');
  expect(pending).not.toContain('Invite code');

  const bound = renderToStaticMarkup(<VprReferralCard status={{ ...REFERRAL, state: 'bound', referrer: INVITER }} />);
  expect(bound).toContain('Bound on-chain.');
  expect(bound).not.toContain('Use invite');
});

it('hides the invite card until the status loads and on networks without referrals', () => {
  expect(renderToStaticMarkup(<VprReferralCard status={null} />)).toBe('');
  expect(renderToStaticMarkup(<VprReferralCard status={{ ...REFERRAL, configured: false, state: 'none' }} />)).toBe('');
});

it('prefills the Rewards invite field from an antseed://invite link', () => {
  receiveInviteLink('AbCdEf_invite');
  const html = renderToStaticMarkup(<VprReferralCard status={{ ...REFERRAL, state: 'none' }} />);
  expect(html).toContain('value="AbCdEf_invite"');
});
