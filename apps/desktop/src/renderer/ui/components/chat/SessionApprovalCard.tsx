import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useFundingStatus } from '../../hooks/useFundingStatus';
import { formatUsd, usdcToBaseUnits } from '../views/funding-status';
import styles from './SessionApprovalCard.module.scss';

type SessionApprovalCardProps = {
  visible: boolean;
  peerName: string | null;
  amount: string;
  peerInfo: {
    reputation: number;
    channelCount: number | null;
    disputeCount: number | null;
    networkAgeDays: number | null;
    evmAddress: string | null;
  } | null;
  error: string | null;
  onAddCredits: () => void;
  onManageSessions?: () => void;
  onRetry: () => void;
  onCancel: () => void;
};

export function SessionApprovalCard({
  visible,
  peerName,
  amount,
  peerInfo,
  error,
  onAddCredits,
  onManageSessions,
  onRetry,
  onCancel,
}: SessionApprovalCardProps) {
  const credits = useUiSelector((state) => ({
    available: state.creditsAvailableUsdc,
    fee: state.creditsDepositFeeUsdc,
  }), shallowEqual);
  const funding = useFundingStatus();
  const available = usdcToBaseUnits(credits.available);
  const required = usdcToBaseUnits(amount || '0');
  const hasCredits = available > 0n && available >= required;

  if (!visible) return null;
  const displayName = peerName || 'this service';

  // Why this session can't start, in the user's terms: where their money is
  // and the one thing that unblocks it.
  const reason = (() => {
    switch (funding.kind) {
      case 'wallet-below-minimum':
      case 'depositing':
        return `${funding.title}.`;
      case 'all-reserved':
        return `${funding.title}. Add funds, or end a session you're done with.`;
      default: {
        const shortfall = required > available ? required - available : 0n;
        return `Add ${formatUsd(shortfall + usdcToBaseUnits(credits.fee), 'up')} or more to continue (includes the network fee).`;
      }
    }
  })();
  const canManage = Boolean(onManageSessions) && funding.actions.includes('manage-sessions');
  const canRetry = funding.kind === 'depositing';

  return (
    <div className={styles.approval}>
      <div className={styles.approvalText}>
        {hasCredits
          ? <>Payment setup failed even though your available deposit balance covers <strong>${amount} USDC</strong> for <strong>{displayName}</strong>. Retry the chat, or manage credits if the problem persists.</>
          : (
            <>
              <strong>{displayName}</strong> needs <strong>${amount}</strong> set aside to start a session; you have {formatUsd(available)} free.
              <span className={styles.approvalReason}>{reason}</span>
            </>
          )
        }
      </div>

      {peerInfo && (peerInfo.reputation > 0 || peerInfo.channelCount !== null) && (
        <div className={styles.approvalStats}>
          {peerInfo.reputation > 0 && <span>{peerInfo.reputation} reputation</span>}
          {peerInfo.channelCount !== null && <span>{peerInfo.channelCount} channels</span>}
          {peerInfo.networkAgeDays !== null && <span>{peerInfo.networkAgeDays}d in network</span>}
        </div>
      )}

      {error && <div className={styles.approvalError}>{error}</div>}

      <div className={styles.approvalActions}>
        <button type="button" className={styles.approveBtn} onClick={hasCredits ? onRetry : onAddCredits}>
          {hasCredits ? 'Retry' : 'Add Credits'}
        </button>
        {!hasCredits && canManage && (
          <button type="button" className={styles.cancelBtn} onClick={onManageSessions}>
            Manage sessions
          </button>
        )}
        {!hasCredits && canRetry && (
          <button type="button" className={styles.cancelBtn} onClick={onRetry}>
            Retry
          </button>
        )}
        <button type="button" className={styles.cancelBtn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
