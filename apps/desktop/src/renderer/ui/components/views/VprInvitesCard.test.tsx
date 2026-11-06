import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import {
  NO_INVITE_CREATION,
  VprInvitesCard,
  VprInvitesCardBody,
  createInviteOnce,
  inviteCardState,
  nextInviteCreation,
  type InviteCreation,
} from './VprInvitesCard';
import type { CreateInviteResult, ReferralInvites } from '../../../types/bridge';

vi.mock('../StakingButton', () => ({ StakingButton: ({ children, page = 'stake', disabled }: { children: React.ReactNode; page?: string; disabled?: boolean }) => <button data-dashboard-page={page} disabled={disabled}>{children}</button> }));
vi.mock('../vpr/VprKit', () => ({ VprPage: ({ children }: { children: React.ReactNode }) => <main>{children}</main>, VprCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, VprBadge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>, VprSettingRow: ({ title, hint, control }: { title: string; hint?: string; control: React.ReactNode }) => <div data-row={title}>{hint}{control}</div> }));

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
    payable: '0',
    claimableEpochs: [],
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
  const html = renderToStaticMarkup(<VprInvitesCard invites={{ available: true, listed: true, allowance: ALLOWANCE, buyers: [], totals: TOTALS, payable: '0', claimableEpochs: [], error: null }} />);
  expect(html).toContain('data-row="Invite someone"');
  expect(html).toContain('3 of 5 left this week.');
  expect(html).toContain('Create link');
  expect(html).toContain('No one has joined with your invites yet.');
  expect(html).not.toContain('Total ·');
});

it('explains why there are no invites without last week\'s activity', () => {
  const html = renderToStaticMarkup(<VprInvitesCard invites={{ available: true, listed: true, allowance: { epoch: 30, quota: 0, used: 0, left: 0 }, buyers: [], totals: TOTALS, payable: '0', claimableEpochs: [], error: null }} />);
  expect(html).toContain('Invites unlock after at least 1 USDC of usage or sales in the previous week.');
  // Antscan's allowance is advisory: the on-chain recheck stays one click away.
  expect(html).not.toContain('Create link');
  expect(html).toContain('Check again');
  expect(html).not.toMatch(/disabled=""[^>]*><span class="as-button__label">Check again/);
});

it('still offers invites when no explorer lists referrals', () => {
  const html = renderToStaticMarkup(<VprInvitesCard invites={{ available: true, listed: false, allowance: null, buyers: [], totals: TOTALS, payable: '0', claimableEpochs: [], error: null }} />);
  expect(html).toContain('Create link');
  expect(html).not.toContain('No one has joined');
  expect(html).not.toContain('Invited wallet');
});

it('hides invites when referrals are not configured', () => {
  expect(renderToStaticMarkup(<VprInvitesCard invites={{ available: false, listed: false, allowance: null, buyers: [], totals: TOTALS, payable: '0', claimableEpochs: [], error: null }} />)).toBe('');
  expect(renderToStaticMarkup(<VprInvitesCard invites={null} />)).toBe('');
});

const INVITES: ReferralInvites = { available: true, listed: true, allowance: ALLOWANCE, buyers: [], totals: TOTALS, payable: '0', claimableEpochs: [], error: null };

it('creates two single-use invites in a row on the same card', async () => {
  const results: CreateInviteResult[] = [
    { ok: true, invite: 'one', link: 'https://antseed.com/invite/FirstInviteCode01', epoch: 30, left: 2, quota: 5, expiresEpoch: 34 },
    { ok: true, invite: 'two', link: 'https://antseed.com/invite/SecondInviteCode2', epoch: 30, left: 1, quota: 5, expiresEpoch: 34 },
  ];
  const createInvite = vi.fn(async () => results.shift()!);
  let creation: InviteCreation = NO_INVITE_CREATION;
  const render = () => renderToStaticMarkup(
    <VprInvitesCardBody invites={INVITES} creation={creation} creating={false} onCreate={() => {}} />,
  );
  expect(render()).toContain('Create link');

  creation = nextInviteCreation(creation, await createInviteOnce(createInvite, ALLOWANCE.epoch));
  let html = render();
  expect(html).toContain('antseed.com/invite/FirstI…de01');
  expect(html).toContain('2 of 5 left this week.');
  expect(html).toContain('Copy');
  expect(html).toContain('Create another');

  // Antscan still reports the pre-creation allowance: the creation's count wins.
  creation = nextInviteCreation(creation, await createInviteOnce(createInvite, ALLOWANCE.epoch));
  html = render();
  expect(createInvite).toHaveBeenCalledTimes(2);
  expect(html).toContain('antseed.com/invite/Second…ode2');
  expect(html).toContain('1 of 5 left this week.');
  expect(html).toContain('Create another');
});

it('drops "Create another" once the week\'s invites are used, and keeps the link after a failed create', async () => {
  const last: CreateInviteResult = { ok: true, invite: 'x', link: 'https://antseed.com/invite/LastInviteCodeXY', epoch: 30, left: 0, quota: 5, expiresEpoch: 34 };
  let creation = nextInviteCreation(NO_INVITE_CREATION, { result: last, epoch: ALLOWANCE.epoch });
  expect(inviteCardState(INVITES, creation)).toMatchObject({ left: 0, canCreate: false });
  expect(renderToStaticMarkup(
    <VprInvitesCardBody invites={INVITES} creation={creation} creating={false} onCreate={() => {}} />,
  )).not.toContain('Create another');
  expect(renderToStaticMarkup(
    <VprInvitesCardBody invites={INVITES} creation={creation} creating={false} onCreate={() => {}} />,
  )).toContain('Check again');

  // A new week resets the count from the refreshed allowance.
  expect(inviteCardState({ ...INVITES, allowance: { epoch: 31, quota: 5, used: 0, left: 5 } }, creation)).toMatchObject({ left: 5, canCreate: true });

  const failed = await createInviteOnce(async () => { throw new Error('signer locked'); }, ALLOWANCE.epoch);
  creation = nextInviteCreation(creation, failed);
  const html = renderToStaticMarkup(
    <VprInvitesCardBody invites={INVITES} creation={creation} creating={false} onCreate={() => {}} />,
  );
  expect(html).toContain('antseed.com/invite/LastIn…deXY');
  expect(html).toContain('signer locked');
});

it('keeps an on-chain recheck when Antscan still reports an exhausted previous week', async () => {
  // Antscan is still on week 30 with nothing left; the chain has moved to week 31.
  const stale: ReferralInvites = { ...INVITES, allowance: { epoch: 30, quota: 5, used: 5, left: 0 } };
  expect(inviteCardState(stale, NO_INVITE_CREATION)).toMatchObject({ left: 0, canCreate: false });
  const onCreate = vi.fn();
  const html = renderToStaticMarkup(<VprInvitesCardBody invites={stale} creation={NO_INVITE_CREATION} creating={false} onCreate={onCreate} />);
  expect(html).toContain('Check again');
  expect(html).not.toMatch(/disabled=""[^>]*><span class="as-button__label">Check again/);

  // The recheck goes through the main-process create, which answers from the chain.
  const fresh: CreateInviteResult = { ok: true, invite: 'n', link: 'https://antseed.com/invite/NewWeekInviteCode', epoch: 31, left: 4, quota: 5, expiresEpoch: 35 };
  const creation = nextInviteCreation(NO_INVITE_CREATION, await createInviteOnce(async () => fresh, 30));
  // The new week's count stands in for the lagging allowance, so another can be created.
  expect(inviteCardState(stale, creation)).toMatchObject({ link: fresh.link, left: 4, quota: 5, canCreate: true });
  const html2 = renderToStaticMarkup(<VprInvitesCardBody invites={stale} creation={creation} creating={false} onCreate={onCreate} />);
  expect(html2).toContain('antseed.com/invite/NewWee…Code');
  expect(html2).toContain('4 of 5 left this week.');
  expect(html2).toContain('Create another');
});

it('clears a no-quota answer once a newer week\'s allowance has invites', async () => {
  const noQuota: CreateInviteResult = { ok: false, reason: 'Invites unlock after at least 1 USDC of usage or sales in the previous week.', noQuota: true };
  const creation = nextInviteCreation(NO_INVITE_CREATION, await createInviteOnce(async () => noQuota, 30));
  expect(creation.failure).toMatchObject({ noQuota: true, epoch: 30 });
  // Same week: the chain's answer stands, but the recheck is still offered.
  expect(inviteCardState(INVITES, creation)).toMatchObject({ noQuota: true, canCreate: false });
  expect(renderToStaticMarkup(<VprInvitesCardBody invites={INVITES} creation={creation} creating={false} onCreate={() => {}} />)).toContain('Check again');

  // The next poll brings week 31 with a fresh quota: creation is back.
  const refreshed: ReferralInvites = { ...INVITES, allowance: { epoch: 31, quota: 3, used: 0, left: 3 } };
  expect(inviteCardState(refreshed, creation)).toMatchObject({ noQuota: false, left: 3, canCreate: true });
  const html = renderToStaticMarkup(<VprInvitesCardBody invites={refreshed} creation={creation} creating={false} onCreate={() => {}} />);
  expect(html).toContain('Create link');
  expect(html).toContain('3 of 3 left this week.');
  expect(html).not.toContain('Invites unlock after');
});

it('inviter rewards get their own claim action, even with no buyer rewards or invite bonus', () => {
  const payable = renderToStaticMarkup(<VprInvitesCard invites={{ ...INVITES, payable: '2.5', claimableEpochs: [28, 29] }} />);
  expect(payable).toContain('2.50 $ANTS payable');
  expect(payable).toContain('From your invites. Paid to your authorized wallet.');
  expect(payable).toContain('Claim ↗');
  const nothing = renderToStaticMarkup(<VprInvitesCard invites={INVITES} />);
  expect(nothing).not.toContain('From your invites.');
});
