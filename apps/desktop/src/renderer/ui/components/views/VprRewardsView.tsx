import { useCallback, useEffect, useState } from 'react';
import { Button } from '@antseed/ui';
import type { GatewayRewardsSummary } from '../../../types/bridge';
import { formatCredits } from '../../../core/format';
import { VprBadge, VprCard, VprSection, VprPage } from '../vpr/VprKit';
import styles from './VprRewardsView.module.scss';

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** The pending amount, or a dash when it can't be shown, or an ellipsis while it's read. */
export function rewardsValue(rewards: GatewayRewardsSummary | null, error: string | null): string {
  if (rewards?.remoteChainUnverified) return '—';
  if (rewards) return formatCredits(rewards.available ? rewards.pendingAnts : '0');
  return error ? '—' : '…';
}

/** The line under the amount: what it is, or why there's none. */
export function rewardsHint(rewards: GatewayRewardsSummary | null, error: string | null): string {
  if (!rewards) return error ?? 'Reading your rewards…';
  // A failed refresh keeps the last amount, but says it may be out of date.
  if (error) return `Couldn't refresh your rewards: ${error}`;
  if (rewards.remoteChainUnverified) return 'Your gateway doesn\'t report rewards to the app yet: see them in your gateway.';
  if (!rewards.available) return 'Rewards are not live on this network yet.';
  const epoch = rewards.currentEpoch !== null ? ` · epoch ${rewards.currentEpoch}` : '';
  return `Earned by your gateway's wallet ${shortAddress(rewards.address)} from usage${epoch}.`;
}

type RewardsRead = { ok: boolean; data?: GatewayRewardsSummary; error?: string };

/**
 * One read of the rewards: a summary replaces the last one and clears the
 * error; a failure sets the error and keeps the last summary on screen.
 */
export async function readRewards(
  read: (() => Promise<RewardsRead> | undefined) | undefined,
  setRewards: (rewards: GatewayRewardsSummary) => void,
  setError: (error: string | null) => void,
): Promise<void> {
  try {
    const result = await read?.();
    if (!result) return;
    if (result.ok && result.data) {
      setRewards(result.data);
      setError(null);
    } else {
      setError(result.error ?? 'Could not read your rewards');
    }
  } catch (err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * A summary of the $ANTS the gateway's wallet earned from usage. Claiming
 * needs the wallet operator's signature, so it happens in the Gateway
 * Console's Rewards page.
 */
export function VprRewardsView() {
  const [rewards, setRewards] = useState<GatewayRewardsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [consoleError, setConsoleError] = useState<string | null>(null);

  const load = useCallback(() => {
    void readRewards(() => window.antseedDesktop?.gatewayGetRewards?.(), setRewards, setError);
  }, []);

  // Read on entry and when the window regains focus, e.g. after claiming in the console.
  useEffect(() => {
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);

  async function openRewards(): Promise<void> {
    setConsoleError(null);
    const result = await window.antseedDesktop?.gatewayOpenConsole?.('/rewards');
    if (result && !result.ok) setConsoleError(result.error ?? 'Could not open your gateway');
  }

  return (
    <section className={`view view-vpr-rewards view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Rewards" root subtitle="$ANTS for the volume you move on the network.">
        <div className={styles.stack}>
          <VprCard className={styles.heroCard}>
            <div className={styles.heroText}>
              <span className={styles.heroLabel}>Pending $ANTS</span>
              <span className={styles.heroValue}>{rewardsValue(rewards, error)}</span>
              <span className={styles.heroHint}>{rewardsHint(rewards, error)}</span>
            </div>
            <div className={styles.heroActions}>
              {rewards?.available && (
                <VprBadge tone="neutral">
                  {rewards.transfersEnabled ? 'Transfers live' : 'Transfers not enabled yet'}
                </VprBadge>
              )}
              <Button variant="primary" onClick={() => { void openRewards(); }}>
                View rewards in your gateway ↗
              </Button>
              {consoleError && <span className={styles.errorNote} role="alert">{consoleError}</span>}
            </div>
          </VprCard>

          <VprSection title="About $ANTS">
            <p className={styles.aboutText}>
              $ANTS are emitted every epoch to the buyers and sellers who moved real USDC volume on the
              network. Your gateway earns them on what your apps and chats spend. Claiming and the
              history per epoch are in your gateway&apos;s Rewards page, where you sign with the wallet
              that operates it.
            </p>
          </VprSection>
        </div>
      </VprPage>
    </section>
  );
}
