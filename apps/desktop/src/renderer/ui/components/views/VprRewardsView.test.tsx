import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { receiveInviteLink, takeIncomingInvite } from '../InviteCodeField';
import {
  VprRefereeBonusCard,
  VprReferralCard,
  VprRewardsView,
  latestOnly,
  pendingHeadline,
  startRewardsRefresh,
} from './VprRewardsView';
import type { RefereeBonus } from '../../../types/bridge';

vi.mock('../../hooks/useActions', () => ({ useActions: () => ({ refreshPaymentSummary: vi.fn() }) }));
vi.mock('../../hooks/useUiSelector', () => ({ shallowEqual: () => true, useUiSelector: () => ({ rewards: { available: true, pendingAnts: '12', currentEpoch: 24, transfersEnabled: false }, loading: false }) }));
vi.mock('../StakingButton', () => ({ StakingButton: ({ children, page = 'stake', disabled }: { children: React.ReactNode; page?: string; disabled?: boolean }) => <button data-dashboard-page={page} disabled={disabled}>{children}</button> }));
vi.mock('../vpr/VprKit', () => ({ VprPage: ({ children }: { children: React.ReactNode }) => <main>{children}</main>, VprCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, VprBadge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>, VprSettingRow: ({ title, hint, control }: { title: string; hint?: string; control: React.ReactNode }) => <div data-row={title}>{hint}{control}</div> }));

it('opens buyer claims and staking through the shared dashboard at their respective destinations', () => {
  const html = renderToStaticMarkup(<VprRewardsView />);
  expect(html).toContain('data-dashboard-page="rewards">Claim rewards');
  expect(html).toContain('data-dashboard-page="stake">Manage staking');
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
  takeIncomingInvite(); // what the mounted field does
});

it('fills only one invite field with a link: an abandoned one never comes back', () => {
  receiveInviteLink('AbCdEf_invite');
  expect(takeIncomingInvite()).toBe('AbCdEf_invite');
  expect(takeIncomingInvite()).toBeNull();
  const html = renderToStaticMarkup(<VprReferralCard status={{ ...REFERRAL, state: 'none' }} />);
  expect(html).not.toContain('AbCdEf_invite');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function refreshTarget() {
  const events = new EventTarget();
  return {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number,
    clearInterval: (id: number) => clearInterval(id),
    focus: () => events.dispatchEvent(new Event('focus')),
  } as unknown as Window & { focus(): void };
}

it('refreshes on entry, on window focus and on the poll interval, and stops on cleanup', () => {
  vi.useFakeTimers();
  try {
    const target = refreshTarget();
    const calls: boolean[] = [];
    const stop = startRewardsRefresh((force) => calls.push(force), 60_000, target);
    expect(calls).toEqual([true]);
    target.focus();
    expect(calls).toEqual([true, true]);
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual([true, true, false]);
    stop();
    target.focus();
    vi.advanceTimersByTime(120_000);
    expect(calls).toEqual([true, true, false]);
  } finally {
    vi.useRealTimers();
  }
});

it('picks up a claimed invite bonus on focus, ignoring a slower earlier response', async () => {
  const before: RefereeBonus = { available: true, weeksLeft: 9, payable: '4.5', claimableEpochs: [28] };
  const after: RefereeBonus = { available: true, weeksLeft: 9, payable: '0', claimableEpochs: [] };
  const responses = [deferred<RefereeBonus>(), deferred<RefereeBonus>()];
  let call = 0;
  let bonus: RefereeBonus | null = null;
  const loader = latestOnly(() => responses[call++]!.promise, (next) => { bonus = next; });
  const target = refreshTarget();
  const stop = startRewardsRefresh(() => loader.run(), 60_000, target);
  // Back from the browser claim: focus starts a second read.
  target.focus();
  responses[1]!.resolve(after);
  await responses[1]!.promise;
  responses[0]!.resolve(before);
  await responses[0]!.promise;
  await Promise.resolve();
  expect(bonus).toEqual(after);
  expect(pendingHeadline({ available: true, pendingAnts: '12' }, bonus).pending).toBe('12');
  const html = renderToStaticMarkup(<VprRefereeBonusCard bonus={bonus} />);
  expect(html).toContain('0.00 $ANTS payable');
  expect(html).toMatch(/disabled=""[^>]*>Claim/);
  stop();

  // Nothing lands after unmount.
  const late = deferred<RefereeBonus>();
  const disposed = latestOnly(() => late.promise, (next) => { bonus = next; });
  disposed.run();
  disposed.dispose();
  late.resolve(before);
  await late.promise;
  await Promise.resolve();
  expect(bonus).toEqual(after);
});
