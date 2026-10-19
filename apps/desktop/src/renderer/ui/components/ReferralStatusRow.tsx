import { useCallback, useState, type ReactNode } from 'react';
import { Button } from '@antseed/ui';
import { shortAddress } from '../../core/format';
import type { ReferralStatus } from '../../types/bridge';
import { InviteCodeField, dismissIncomingInvite, useIncomingInvite } from './InviteCodeField';
import { VprBadge, VprSettingRow } from './vpr/VprKit';

const REFERRAL_HINTS: Record<Exclude<ReferralStatus['state'], 'none'>, string> = {
  bound: 'Bound on-chain. You both earn bonus $ANTS for 12 weeks.',
  invited: 'Pending. Binds with your first paid or free request.',
};

/**
 * This wallet's side of a referral, shared by Preferences and Rewards: the
 * invite field while it has neither an inviter nor a pending invite, else who
 * invited it (pending until the first settlement binds it). A bound inviter
 * is final; a pending invite can be replaced, since it may have expired or
 * been used before it bound.
 */
export function ReferralStatusRow({ status, onRedeemed }: { status: ReferralStatus; onRedeemed?: () => void }) {
  if (status.state === 'none' || !status.referrer) return <InviteCodeField onRedeemed={onRedeemed} />;
  if (status.state === 'bound') return <InviterRow referrer={status.referrer} state="bound" />;
  // Keyed by the pending invite: once a replacement is saved and re-read, the row starts over.
  return <PendingReferralRow key={status.invite ?? status.referrer} referrer={status.referrer} onRedeemed={onRedeemed} />;
}

/**
 * A pending (unbound) invite with a Replace invite action. An antseed://invite
 * link opens the field too, prefilled with the link's invite. Saving goes
 * through the same checked redemption as a first invite.
 */
export function PendingReferralRow({ referrer, onRedeemed }: { referrer: string; onRedeemed?: () => void }) {
  const [replacing, setReplacing] = useState(false);
  const openReplace = useCallback(() => setReplacing(true), []);
  useIncomingInvite(openReplace);

  if (replacing) {
    return (
      <InviteCodeField
        prompt={`Replaces the pending invite from ${shortAddress(referrer)}.`}
        onRedeemed={onRedeemed}
        onCancel={() => {
          dismissIncomingInvite();
          setReplacing(false);
        }}
      />
    );
  }
  return (
    <InviterRow
      referrer={referrer}
      state="invited"
      action={<Button size="sm" variant="link" onClick={openReplace}>Replace invite</Button>}
    />
  );
}

function InviterRow({ referrer, state, action }: { referrer: string; state: 'invited' | 'bound'; action?: ReactNode }) {
  return (
    <VprSettingRow
      title="Invited by"
      hint={REFERRAL_HINTS[state]}
      control={(
        <>
          <span title={referrer}>
            <VprBadge tone={state === 'bound' ? 'green' : 'neutral'}>{shortAddress(referrer)}</VprBadge>
          </span>
          {action}
        </>
      )}
    />
  );
}
