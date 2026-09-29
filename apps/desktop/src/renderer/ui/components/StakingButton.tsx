import { useEffect, useRef, useState, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Copy01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { InfoTooltip } from './InfoTooltip';
import styles from './StakingButton.module.scss';

/** Open the browser dashboard and surface launcher failures. */
export function StakingButton({ className, children, page = 'stake', disabled = false, copyDisabled = false }: { className?: string; children: ReactNode; page?: 'stake' | 'rewards'; disabled?: boolean; copyDisabled?: boolean }) {
  const inFlight = useRef({ open: false, copy: false });
  const [busy, setBusy] = useState({ open: false, copy: false });
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const destination = page === 'rewards' ? 'rewards' : 'staking';
  const copyLabel = copied ? 'Link copied' : `Copy ${destination} link`;

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const run = async (action: 'open' | 'copy') => {
    if (inFlight.current[action]) return;
    inFlight.current[action] = true;
    setBusy((current) => ({ ...current, [action]: true }));
    setError('');
    if (action === 'copy') setCopied(false);
    try {
      const launch = action === 'copy' ? window.antseedDesktop?.stakingCopyLink : window.antseedDesktop?.stakingOpen;
      if (!launch) throw new Error('Staking is available in the VPR desktop app.');
      const result = await launch({ page });
      if (!result.ok) throw new Error(result.error || (action === 'copy' ? 'Could not copy the dashboard link.' : 'Could not open Staking.'));
      if (action === 'copy') setCopied(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open Staking.');
    } finally {
      inFlight.current[action] = false;
      setBusy((current) => ({ ...current, [action]: false }));
    }
  };
  return <>
    <div className={styles.split} role="group" aria-label={`${page === 'rewards' ? 'Rewards' : 'Staking'} dashboard`}>
      <button type="button" className={[className, styles.primary].filter(Boolean).join(' ')} onClick={() => void run('open')} disabled={busy.open || disabled} aria-busy={busy.open}>
        {busy.open ? 'Opening…' : children}
      </button>
      <InfoTooltip narrow content={<><strong>{copyLabel}</strong><span>Paste into your preferred browser on this computer. Keep AntSeed open and don’t share this session link.</span></>}>
        <button type="button" className={styles.copy} onClick={() => void run('copy')} disabled={busy.copy || copyDisabled} aria-label={copyLabel} aria-busy={busy.copy}>
          <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </InfoTooltip>
    </div>
    <span role="status" className={styles.status}>{copied ? `${page === 'rewards' ? 'Rewards' : 'Staking'} link copied. Paste into your preferred browser on this computer. Keep AntSeed open.` : ''}</span>
    {error && <span role="alert" className={styles.error}>{error}</span>}
  </>;
}
