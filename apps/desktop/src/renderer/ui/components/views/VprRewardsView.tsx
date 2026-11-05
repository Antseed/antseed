import { useCallback, useEffect, useState } from 'react';
import { Button } from '@antseed/ui';
import type { GatewayRewardsSummary } from '../../../types/bridge';
import { formatCredits } from '../../../core/format';
import { VprBadge, VprCard, VprPage } from '../vpr/VprKit';
import styles from './VprRewardsView.module.scss';

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
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

  const load = useCallback((force: boolean) => {
    void window.antseedDesktop?.gatewayGetRewards?.({ force })
      .then((result) => {
        if (result.ok && result.data) {
          setRewards(result.data);
          setError(null);
        } else {
          setError(result.error ?? 'Could not read your rewards');
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  // Fresh on entry and when the window regains focus, e.g. after claiming in the console.
  useEffect(() => {
    load(true);
    const onFocus = () => load(true);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  async function openRewards(): Promise<void> {
    setConsoleError(null);
    const result = await window.antseedDesktop?.gatewayOpenConsole?.('/rewards');
    if (result && !result.ok) setConsoleError(result.error ?? 'Could not open your gateway');
  }

  const pending = rewards?.available ? rewards.pendingAnts : '0';

  return (
    <section className={`view view-vpr-rewards view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Rewards" root>
        <div className={styles.stack}>
          <VprCard className={styles.heroCard}>
            <div className={styles.heroText}>
              <span className={styles.heroLabel}>Pending $ANTS</span>
              <span className={styles.heroValue}>{rewards ? formatCredits(pending) : error ? '—' : '…'}</span>
              <span className={styles.heroHint}>
                {!rewards
                  ? error ?? 'Reading your rewards…'
                  : rewards.available
                    ? `Earned by your gateway's wallet ${shortAddress(rewards.address)} from usage${rewards.currentEpoch !== null ? ` · epoch ${rewards.currentEpoch}` : ''}.`
                    : 'Rewards are not live on this network yet.'}
              </span>
            </div>
            <div className={styles.heroActions}>
              {rewards?.available && (
                <VprBadge tone="neutral">
                  {rewards.transfersEnabled ? 'Transfers live' : 'Transfers not enabled yet'}
                </VprBadge>
              )}
              <Button variant="brand" size="sm" onClick={() => { void openRewards(); }}>
                View rewards in your gateway ↗
              </Button>
              {consoleError && <span className={styles.errorNote} role="alert">{consoleError}</span>}
            </div>
          </VprCard>

          <VprCard className={styles.aboutCard}>
            <span className={styles.aboutTitle}>About $ANTS</span>
            <span className={styles.aboutText}>
              $ANTS are emitted every epoch to the buyers and sellers who moved real USDC volume on the
              network. Your gateway earns them on what your apps and chats spend. Claiming and the
              history per epoch are in your gateway&apos;s Rewards page, where you sign with the wallet
              that operates it.
            </span>
          </VprCard>
        </div>
      </VprPage>
    </section>
  );
}
