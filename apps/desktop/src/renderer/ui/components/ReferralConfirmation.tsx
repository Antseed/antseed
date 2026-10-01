import { useState } from 'react';
import { setReferralSetupStatus } from '../../modules/app/setup';
import { useUiSelector } from '../hooks/useUiSelector';
import type { ReferralSetupStatus } from '../../types/bridge';
import styles from './ReferralConfirmation.module.scss';

/**
 * First-run referral question. Rendered by the setup screen and by Home, so
 * the candidate survives setup auto-dismissing (or the app being closed) —
 * the answer is persisted by the main process and shared through uiState.
 */
export function ReferralConfirmation() {
  const status = useUiSelector((state) => state.referralSetup);
  const bridge = typeof window === 'undefined' ? undefined : window.antseedDesktop;
  const [busy, setBusy] = useState(false);
  if ((status.state !== 'candidate' && status.state !== 'error') || !status.referrer) return null;
  const referrer = status.referrer;
  const accept = bridge?.referralAccept;

  const act = async (action: (() => Promise<ReferralSetupStatus>) | undefined) => {
    if (!action) return;
    setBusy(true);
    try {
      setReferralSetupStatus(await action());
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.referralCard} aria-label="Referral confirmation">
      <strong>Did someone invite you?</strong>
      <p>
        An invite link with this wallet was recently used to download AntSeed from your network:
      </p>
      <p className={styles.referralAddress}>{referrer}</p>
      <p>
        Only confirm if you know this wallet is your inviter&apos;s. The match is by network, so on a
        shared connection it can belong to someone else, and a confirmed referral cannot be changed
        later. Your inviter then earns a share of network emissions from your usage; it costs you
        nothing.
      </p>
      {status.confidence === 'low' ? (
        <p className={styles.referralWarning}>
          More than one invite link was used from this network recently.
        </p>
      ) : null}
      {status.state === 'error' ? (
        <p className={styles.referralWarning} role="alert">{status.error}</p>
      ) : null}
      <div className={styles.referralActions}>
        <button
          type="button"
          className={styles.referralDecline}
          onClick={() => void act(bridge?.referralDecline)}
          disabled={busy}
        >
          Not my inviter
        </button>
        <button
          type="button"
          onClick={() => void act(accept ? () => accept(referrer) : undefined)}
          disabled={busy}
        >
          {busy ? 'Confirming…' : 'Yes, this is my inviter'}
        </button>
      </div>
    </section>
  );
}
