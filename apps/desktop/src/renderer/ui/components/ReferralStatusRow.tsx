import { useCallback, useState } from 'react';
import { Button } from '@antseed/ui';
import { shortAddress } from '../../core/format';
import type { ReferralStatus } from '../../types/bridge';
import { InviteCodeField, useIncomingInvite } from './InviteCodeField';
import { VprBadge, VprSettingRow } from './vpr/VprKit';
import styles from './ReferralStatusRow.module.scss';

const REFERRAL_HINTS: Record<Exclude<ReferralStatus['state'], 'none'>, string> = {
  bound: 'Bound on-chain. You both earn bonus $ANTS for 12 weeks.',
  invited: 'Pending. Binds with your first paid or free request.',
};

export const REMOVE_FAILED = 'Could not remove it. Try again.';

/**
 * Remove the pending invite; returns the error to show, or null once removed
 * (`onRemoved` then reloads the status). A failure keeps the invite pending.
 */
export async function removePendingInvite(clearInvite: () => Promise<unknown>, onRemoved?: () => void): Promise<string | null> {
  try {
    await clearInvite();
  } catch {
    return REMOVE_FAILED;
  }
  onRemoved?.();
  return null;
}

type Props = {
  status: ReferralStatus;
  /** Called after the pending invite was saved, replaced or removed (reload the status). */
  onRedeemed?: () => void;
  /** Start with the invite field open over a pending invite (tests). */
  initialChanging?: boolean;
};

/**
 * This wallet's side of a referral, shared by Preferences and Rewards: the
 * invite field while it has neither an inviter nor a pending invite, else who
 * invited it. Only a binding is final: a pending invite can expire or be used
 * by someone else first, so it can be changed (an antseed://invite link opens
 * the field prefilled) or removed until the first settlement binds it.
 */
export function ReferralStatusRow({ status, onRedeemed, initialChanging = false }: Props) {
  const [changing, setChanging] = useState(initialChanging);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const pending = status.state === 'invited';

  useIncomingInvite(useCallback(() => setChanging(true), []));
  const saved = () => { setChanging(false); onRedeemed?.(); };

  if (status.state === 'none' || !status.referrer) return <InviteCodeField onRedeemed={saved} />;
  if (pending && changing) return <InviteCodeField onRedeemed={saved} onCancel={() => setChanging(false)} />;

  const remove = async () => {
    const clearInvite = window.antseedDesktop?.referralClearInvite;
    if (!clearInvite) return;
    setRemoving(true);
    setRemoveError(null);
    setRemoveError(await removePendingInvite(clearInvite, onRedeemed));
    setRemoving(false);
  };

  return (
    <VprSettingRow
      title="Invited by"
      hint={REFERRAL_HINTS[status.state]}
      control={(
        <span className={styles.actions}>
          <span title={status.referrer}>
            <VprBadge tone={status.state === 'bound' ? 'green' : 'neutral'}>{shortAddress(status.referrer)}</VprBadge>
          </span>
          {pending ? (
            <>
              {removeError ? <span role="alert" className={styles.error}>{removeError}</span> : null}
              <Button size="sm" variant="link" onClick={() => setChanging(true)} disabled={removing}>Change</Button>
              <Button size="sm" variant="link" onClick={() => void remove()} disabled={removing} aria-busy={removing}>
                {removing ? 'Removing…' : 'Remove'}
              </Button>
            </>
          ) : null}
        </span>
      )}
    />
  );
}
