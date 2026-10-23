import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon } from '@hugeicons/core-free-icons';
import type { DiscoverRow } from '../../../core/state';
import type { ChatAiStreamStopReason } from '../../../types/bridge';
import { nextTier, openSellerPool, tierAllowance, tierAnts } from '../../../modules/catalog/free-tier';
import styles from './FundingStatusNotice.module.scss';

type FreeTierLimit = NonNullable<ChatAiStreamStopReason['freeTier']>;

const peerKey = (peerId: string): string => peerId.toLowerCase().replace(/^0x/, '');

function formatWait(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

/**
 * A seller's free limit ran out: which seller, when it resets, and the next
 * staked tier with a link that opens staking on that seller's own pool.
 */
export function FreeTierLimitNotice({ limit, rows, onDismiss }: {
  limit: FreeTierLimit;
  rows: readonly DiscoverRow[];
  onDismiss: () => void;
}): JSX.Element {
  const row = limit.peerId ? rows.find((entry) => peerKey(entry.peerId) === peerKey(limit.peerId!)) : undefined;
  const seller = row?.peerDisplayName || row?.peerLabel || 'this seller';
  const next = nextTier(limit.stakeTiers, limit.stakePower);
  const pool = row?.agentId ?? 0;
  const title = limit.limitedBy === 'stake'
    ? `Your staked free allowance on ${seller} is used up`
    : `Free limit reached on ${seller}`;
  const body = [
    limit.retryAfterSeconds !== null ? `Resets in ${formatWait(limit.retryAfterSeconds)}.` : '',
    next ? `Lock ${tierAnts(next)} for a year in ${seller}'s pool for ${tierAllowance(next).toLowerCase()}. Stake in other pools doesn't count here.` : '',
  ].filter(Boolean).join(' ');
  return (
    <div className={`${styles.notice} ${styles.card}`} role="status">
      <span className={`${styles.dot} ${styles.dotWarning}`} aria-hidden="true" />
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        {body ? <span className={styles.body}>{body}</span> : null}
      </span>
      {next && pool > 0 ? (
        <span className={styles.actions}>
          <button type="button" className={styles.link} onClick={() => openSellerPool(pool)}>Stake in this pool ↗</button>
        </span>
      ) : null}
      <button type="button" className={styles.dismiss} aria-label="Dismiss" onClick={onDismiss}>
        <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
      </button>
    </div>
  );
}
