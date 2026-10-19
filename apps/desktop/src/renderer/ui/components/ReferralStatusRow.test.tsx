import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { shallowRender, textOf, type AnyElement } from '../test/shallowRender';
import { InviteCodeField, dismissIncomingInvite, receiveInviteLink } from './InviteCodeField';
import { PendingReferralRow, ReferralStatusRow } from './ReferralStatusRow';

const OLD_INVITER = '0x1111111111111111111111111111111111111111';
const NEW_INVITER = '0x4444444444444444444444444444444444444444';
const PENDING = { configured: true, state: 'invited', referrer: OLD_INVITER, invite: 'expired-invite' } as const;

/** The checked redemption path: previewInvite rejects the expired invite, accepts a fresh one. */
function referralBridge() {
  const check = async (invite: string) => (invite === 'expired-invite'
    ? { ok: false as const, reason: 'This invite has expired.' }
    : { ok: true as const, referrer: NEW_INVITER, invite });
  return { referralCheckInvite: vi.fn(check), referralRedeemInvite: vi.fn(check) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  dismissIncomingInvite();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const inviteInput = (field: ReturnType<typeof shallowRender>) => field.findAll((el) => el.props.name === 'invite-code')[0]!;

it('replaces an expired pending invite with a valid one through the checked redemption', async () => {
  const bridge = referralBridge();
  vi.stubGlobal('antseedDesktop', bridge);
  const onRedeemed = vi.fn();

  const status = shallowRender(<ReferralStatusRow status={PENDING} onRedeemed={onRedeemed} />);
  const pendingRow = status.root as AnyElement;
  expect(pendingRow.type).toBe(PendingReferralRow);
  expect(pendingRow.key).toBe('expired-invite');

  const row = shallowRender(pendingRow);
  expect((row.root as AnyElement).props).toMatchObject({ referrer: OLD_INVITER, state: 'invited' });
  (row.button('Replace invite').props.onClick as () => void)();

  const fieldElement = row.root as AnyElement;
  expect(fieldElement.type).toBe(InviteCodeField);
  expect(fieldElement.props.prompt).toBe('Replaces the pending invite from 0x1111...1111.');
  const field = shallowRender(fieldElement);

  // The pending invite expired: entering it again is rejected by the check.
  (inviteInput(field).props.onChange as (event: unknown) => void)({ target: { value: 'expired-invite' } });
  await vi.advanceTimersByTimeAsync(300);
  expect(inviteInput(field).props.error).toBe('This invite has expired.');
  expect(field.button('Use invite').props.disabled).toBe(true);

  // A fresh invite checks out and is saved in place of the pending one.
  (inviteInput(field).props.onChange as (event: unknown) => void)({ target: { value: 'fresh-invite' } });
  await vi.advanceTimersByTimeAsync(300);
  expect(inviteInput(field).props.error).toBeUndefined();
  expect(inviteInput(field).props.hint).toBe('Invite from 0x4444...4444.');
  (field.button('Use invite').props.onClick as () => void)();
  await vi.advanceTimersByTimeAsync(0);

  expect(bridge.referralRedeemInvite).toHaveBeenCalledTimes(1);
  expect(bridge.referralRedeemInvite).toHaveBeenCalledWith('fresh-invite');
  expect(onRedeemed).toHaveBeenCalledWith({ ok: true, referrer: NEW_INVITER, invite: 'fresh-invite' });
  expect(textOf(field.root)).toContain('Invite from 0x4444...4444 saved.');

  // Re-read status: a new pending invite starts a fresh row.
  const next = shallowRender(<ReferralStatusRow status={{ ...PENDING, referrer: NEW_INVITER, invite: 'fresh-invite' }} />);
  expect((next.root as AnyElement).key).toBe('fresh-invite');
  expect((next.root as AnyElement).props.referrer).toBe(NEW_INVITER);
});

it('keeps a bound inviter final: no replace action', () => {
  const status = shallowRender(<ReferralStatusRow status={{ ...PENDING, state: 'bound', invite: null }} />);
  const row = shallowRender(status.root as AnyElement);
  expect(row.findAll((el) => el.props.title === OLD_INVITER)).toHaveLength(1);
  expect(row.hasButton('Replace invite')).toBe(false);
});

it('opens the replace field for an antseed://invite link, before or after the row mounts', () => {
  vi.stubGlobal('antseedDesktop', referralBridge());

  receiveInviteLink('linked-invite');
  const row = shallowRender(<PendingReferralRow referrer={OLD_INVITER} />);
  const fieldElement = row.root as AnyElement;
  expect(fieldElement.type).toBe(InviteCodeField);
  expect(inviteInput(shallowRender(fieldElement)).props.value).toBe('linked-invite');

  // Cancel keeps the pending invite and drops the link.
  (fieldElement.props.onCancel as () => void)();
  expect(row.hasButton('Replace invite')).toBe(true);
  expect(shallowRender(<PendingReferralRow referrer={OLD_INVITER} />).hasButton('Replace invite')).toBe(true);

  // A link arriving while the row is shown opens the field too.
  receiveInviteLink('later-invite');
  expect((row.root as AnyElement).type).toBe(InviteCodeField);
  row.unmount();
});
