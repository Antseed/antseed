import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon, HelpCircleIcon } from '@hugeicons/core-free-icons';
import { formatCredits } from '../../../core/format';
import { InfoTooltip } from '../InfoTooltip';
import {
  hasPositiveAmount,
  isEntireBalanceLocked,
  walletBalanceMessage,
  type BalanceBreakdownValues,
} from './balance-breakdown';
import { formatUsd, SESSION_RESERVE_BASE_UNITS, type FundingStatusKind } from './funding-status';
import { useFundingStatus } from '../../hooks/useFundingStatus';
import styles from './BalanceBreakdown.module.scss';

const WALLET_FUNDING_KINDS = new Set<FundingStatusKind>(['wallet-below-minimum', 'depositing', 'wallet-at-limit', 'wallet-dust']);

export function BalanceWarning({ values }: { values: BalanceBreakdownValues }): JSX.Element | null {
  if (!isEntireBalanceLocked(values)) return null;
  return (
    <InfoTooltip
      align="left"
      content={(
        <>
          <strong>Your available balance is locked</strong>
          <span>${formatCredits(values.reserved)} is held in open payment channels, leaving no balance available to start another paid session or withdraw. Funds become available again when those channels close.</span>
        </>
      )}
    >
      <button type="button" className={styles.warningButton} aria-label="Some balance is held in open sessions">
        <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={2} />
      </button>
    </InfoTooltip>
  );
}

export function BalanceBreakdown({ values, compact = false, onManageOpenSessions }: {
  values: BalanceBreakdownValues;
  compact?: boolean;
  onManageOpenSessions?: () => void;
}): JSX.Element {
  const funding = useFundingStatus();
  // The funding status knows why wallet USDC hasn't moved (below the first-
  // deposit minimum, smaller than the fee, at the limit); prefer its wording.
  const walletMessage = WALLET_FUNDING_KINDS.has(funding.kind) ? funding.body : walletBalanceMessage(values);
  const hasReserved = hasPositiveAmount(values.reserved);
  return (
    <div className={`${styles.breakdown}${compact ? ` ${styles.compact}` : ''}`}>
      {/* With money held in sessions, "ready" is the number that decides
          whether another session can start — show it even at $0.00. */}
      {hasPositiveAmount(values.available) || hasReserved ? (
        <div className={styles.row}>
          <span>Available for new sessions</span><span>${formatCredits(values.available)}</span>
        </div>
      ) : null}
      {hasReserved ? (
        <div className={styles.row}>
          <span className={styles.rowLabel}>
            Held in open sessions
            <InfoTooltip
              align="left"
              content={(
                <span>
                  Each seller session sets aside {formatUsd(SESSION_RESERVE_BASE_UNITS)} at a time from your available
                  credits. Only that seller can draw on it; whatever it doesn't use comes back when the session closes.
                </span>
              )}
            >
              <button type="button" className={styles.infoButton} aria-label="About held funds">i</button>
            </InfoTooltip>
            <BalanceWarning values={values} />
            {onManageOpenSessions ? (
              <button
                type="button"
                className={styles.manageButton}
                aria-label="Manage open sessions"
                onClick={onManageOpenSessions}
              >
                (Manage)
              </button>
            ) : null}
          </span>
          <span>${formatCredits(values.reserved)}</span>
        </div>
      ) : null}
      {hasReserved ? funding.sessions.map((session, index) => (
        <div key={`${session.sellerName}-${index}`} className={`${styles.row} ${styles.subRow}`}>
          <span className={styles.subRowLabel}>{session.sellerName}</span>
          <span>
            {formatUsd(session.heldBaseUnits)}
            {session.unusedBaseUnits > 0n && session.unusedBaseUnits < session.heldBaseUnits
              ? <span className={styles.subRowNote}> ({formatUsd(session.unusedBaseUnits)} unused)</span>
              : null}
          </span>
        </div>
      )) : null}
      {hasPositiveAmount(values.pending) ? (
        <div className={styles.row}>
          <span>Authorized, not yet charged</span>
          <span>-${formatCredits(values.pending)}</span>
        </div>
      ) : null}
      {hasPositiveAmount(values.wallet) ? (
        <div className={styles.row}>
          <span className={styles.rowLabel}>
            In deposit wallet (not in credits yet)
            <InfoTooltip align="left" content={<span>{walletMessage}</span>}>
              <button type="button" className={styles.infoButton} aria-label="About deposit wallet balance">i</button>
            </InfoTooltip>
          </span>
          <span>${formatCredits(values.wallet)}</span>
        </div>
      ) : null}
      <div className={`${styles.row} ${styles.totalRow}`}>
        <span>Total balance</span><span>${formatCredits(values.totalOwned)}</span>
      </div>
      {hasPositiveAmount(values.wallet) ? <p className={styles.walletNote}>{walletMessage}</p> : null}
    </div>
  );
}

export function BalanceInfoPopover({ values, onManageOpenSessions }: {
  values: BalanceBreakdownValues;
  onManageOpenSessions?: () => void;
}): JSX.Element {
  return (
    <InfoTooltip
      align="left"
      wide
      interactive
      content={(
        <>
          <strong>Where your balance is</strong>
          <BalanceBreakdown values={values} compact onManageOpenSessions={onManageOpenSessions} />
        </>
      )}
    >
      <button
        type="button"
        className={styles.popoverButton}
        aria-label="Show balance details"
      >
        <HugeiconsIcon icon={HelpCircleIcon} size={14} strokeWidth={2} />
      </button>
    </InfoTooltip>
  );
}
