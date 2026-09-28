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
  const shortReferrer = `${referrer.slice(0, 6)}…${referrer.slice(-4)}`;
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
      <strong>Were you invited by {shortReferrer}?</strong>
      <p>
        This wallet shared the download link on your network. If you confirm, your inviter earns 2% of
        the ANTS you earn from usage, paid from network emissions. It costs you nothing and is recorded
        with your first request.
      </p>
      {status.confidence === 'low' ? (
        <p className={styles.referralWarning}>
          More than one invite link was used from this network recently. Check the wallet carefully.
        </p>
      ) : null}
      {status.state === 'error' ? (
        <p className={styles.referralWarning} role="alert">{status.error}</p>
      ) : null}
      <div className={styles.referralActions}>
        <button type="button" onClick={() => void act(bridge?.referralDecline)} disabled={busy}>Not my inviter</button>
        <button
          type="button"
          className={styles.referralConfirm}
          onClick={() => void act(accept ? () => accept(referrer) : undefined)}
          disabled={busy}
        >
          {busy ? 'Confirming…' : 'Confirm referral'}
        </button>
      </div>
    </section>
  );
}
