import { useCallback, useEffect, useState } from 'react';
import { shortAddress } from '../../../core/format';
import type { FreeTierSharing } from '../../../types/bridge';
import { freeTierTrendLine } from '../../../modules/catalog/free-tier';
import { refreshFreeTierStake, useFreeTierStake } from '../../hooks/useFreeTierStake';
import { useUiSelector } from '../../hooks/useUiSelector';
import { VprCard } from '../vpr/VprKit';
import styles from './VprRewardsView.module.scss';

/**
 * Staked free tier: a staker creates a code for this buyer in the staking
 * dashboard (My positions → Share free tier) and the buyer pastes it here.
 * Sellers with a staked free tier then count that stake toward this buyer.
 * Below the stakers, the stake each seller counts and how it shrinks.
 */
export function VprFreeTierCard() {
  const bridge = typeof window === 'undefined' ? undefined : window.antseedDesktop;
  const [sharing, setSharing] = useState<FreeTierSharing | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const stake = useFreeTierStake();
  const rows = useUiSelector((state) => state.discoverRows);
  const sellerName = (agentId: number) => {
    const row = rows.find((entry) => entry.agentId === agentId);
    return row?.peerDisplayName || row?.peerLabel || `Seller #${agentId}`;
  };

  const apply = useCallback(async (call: Promise<{ ok: boolean; data?: FreeTierSharing; error?: string }> | undefined) => {
    if (!call) return false;
    const result = await call;
    if (result.ok && result.data) {
      setSharing(result.data);
      setError(null);
      return true;
    }
    setError(result.error ?? 'Could not update the free tier.');
    return false;
  }, []);

  useEffect(() => {
    void apply(bridge?.freeTierList?.());
  }, [apply, bridge]);

  // One change at a time: each one returns the saved list the next one builds on.
  const mutate = async (call: () => Parameters<typeof apply>[0]) => {
    setBusy(true);
    try {
      const applied = await apply(call());
      if (applied) refreshFreeTierStake();
      return applied;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (await mutate(() => bridge?.freeTierAdd?.(code.trim()))) setCode('');
  };

  const copyBuyer = () => {
    if (!sharing) return;
    void navigator.clipboard?.writeText(sharing.buyer).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <VprCard className={styles.aboutCard}>
      <span className={styles.aboutTitle}>Staked free tier</span>
      <span className={styles.aboutText}>
        On each seller with a staked free tier, stake in that seller's pool raises your free limit there, or unlocks models it offers free only to its stakers, including stake shared with you. Ask a staker for a code for your address
        {sharing ? <>{' '}<button type="button" className={styles.inlineLink} onClick={copyBuyer} title={sharing.buyer}>{copied ? 'copied' : shortAddress(sharing.buyer)}</button></> : null}.
      </span>
      {sharing && sharing.stakers.length > 0 ? (
        <ul className={styles.stakerList}>
          {sharing.stakers.map((entry) => (
            <li key={entry.staker} className={styles.stakerRow}>
              <span className={styles.stakerAddress} title={entry.staker}>{shortAddress(entry.staker)}</span>
              <span className={styles.aboutText}>{entry.expired ? 'Expired' : `Until ${new Date(entry.expiresAt * 1000).toLocaleDateString()}`}</span>
              <button type="button" className={styles.inlineLink} disabled={busy} onClick={() => void mutate(() => bridge?.freeTierRemove?.(entry.staker))}>Remove</button>
            </li>
          ))}
        </ul>
      ) : null}
      {stake && stake.pools.length > 0 ? (
        <ul className={styles.stakerList} aria-label="Counted stake by seller">
          {stake.pools.map((pool) => (
            <li key={pool.agentId} className={styles.stakerRow}>
              <span className={styles.stakerName}>{sellerName(pool.agentId)}</span>
              <span className={styles.aboutText}>{freeTierTrendLine(stake, pool)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.codeRow}>
        <input
          className={styles.codeInput}
          placeholder="antseed-free-tier-…"
          value={code}
          spellCheck={false}
          onChange={(event) => setCode(event.target.value)}
          aria-label="Free-tier code"
        />
        <button type="button" className={styles.claimButton} disabled={busy || !code.trim()} onClick={() => void add()}>
          Add code
        </button>
      </div>
      {error ? <span className={styles.aboutText}>{error}</span> : null}
    </VprCard>
  );
}
