import { shortAddress } from '../../core/format';
import type { ReferralStatus } from '../../types/bridge';
import { InviteCodeField } from './InviteCodeField';
import { VprBadge, VprSettingRow } from './vpr/VprKit';

const REFERRAL_HINTS: Record<Exclude<ReferralStatus['state'], 'none'>, string> = {
  bound: 'Bound on-chain. You both earn bonus $ANTS for 12 weeks.',
  invited: 'Pending. Binds with your first paid or free request.',
};

/**
 * This wallet's side of a referral, shared by Preferences and Rewards: the
 * invite field while it has neither an inviter nor a pending invite, else who
 * invited it (pending until the first settlement binds it).
 */
export function ReferralStatusRow({ status, onRedeemed }: { status: ReferralStatus; onRedeemed?: () => void }) {
  if (status.state === 'none' || !status.referrer) return <InviteCodeField onRedeemed={onRedeemed} />;
  return (
    <VprSettingRow
      title="Invited by"
      hint={REFERRAL_HINTS[status.state]}
      control={(
        <span title={status.referrer}>
          <VprBadge tone={status.state === 'bound' ? 'green' : 'neutral'}>{shortAddress(status.referrer)}</VprBadge>
        </span>
      )}
    />
  );
}
