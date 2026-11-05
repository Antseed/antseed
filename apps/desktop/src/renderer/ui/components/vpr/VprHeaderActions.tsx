import { HugeiconsIcon } from '@hugeicons/react';
import { Globe02Icon, HelpCircleIcon, Settings01Icon } from '@hugeicons/core-free-icons';
import { useState } from 'react';
import { Skeleton } from '@antseed/ui';
import { formatCredits } from '../../../core/format';
import type { ViewName } from '../../types';
import { useFundingStatus } from '../../hooks/useFundingStatus';
import { useUiSelector } from '../../hooks/useUiSelector';
import { useOptionalPublicEndpointModal } from '../tunnels/PublicEndpointModal';
import styles from './VprHeaderActions.module.scss';

type Props = {
  credits: string;
  onSelectView?: (view: ViewName) => void;
  className?: string;
};

export function VprHeaderActions({ credits, onSelectView, className }: Props) {
  return (
    <div className={`${styles.actions}${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className={styles.iconButton}
        title="Help"
        aria-label="Help"
        onClick={() => onSelectView?.('help')}
      >
        <HugeiconsIcon icon={HelpCircleIcon} size={18} strokeWidth={1.8} />
      </button>
      <GatewayConsoleButton />
      <button
        type="button"
        className={styles.iconButton}
        title="Settings"
        aria-label="Settings"
        onClick={() => onSelectView?.('preferences')}
      >
        <HugeiconsIcon icon={Settings01Icon} size={18} strokeWidth={1.8} />
      </button>
      <CreditsButton credits={credits} onClick={() => onSelectView?.('deposit')} />
    </div>
  );
}

/** Opens the console (or its setup link); falls back to the Public endpoint dialog when there is none. */
export async function openGatewayConsole(
  claimConsole: (() => Promise<{ ok: boolean }>) | undefined,
  onOpenPublicEndpoint: (() => void) | undefined,
): Promise<void> {
  try {
    const result = await claimConsole?.();
    if (!result?.ok) onOpenPublicEndpoint?.();
  } catch {
    onOpenPublicEndpoint?.();
  }
}

/**
 * Globe that opens the gateway console. The console only exists while a public
 * endpoint runs, so the click depends on that: a claimed console opens in the
 * browser, an unclaimed one opens its one-time setup link, and with no endpoint
 * running the Public endpoint dialog opens so the user can start one.
 */
function GatewayConsoleButton() {
  const modal = useOptionalPublicEndpointModal();
  return <GatewayConsoleLink onOpenPublicEndpoint={modal?.openPublicEndpointModal} />;
}

function GatewayConsoleLink({ onOpenPublicEndpoint }: { onOpenPublicEndpoint?: () => void }) {
  const [opening, setOpening] = useState(false);
  const open = async () => {
    if (opening) return;
    setOpening(true);
    try {
      await openGatewayConsole(window.antseedDesktop?.publicTunnelClaimConsole, onOpenPublicEndpoint);
    } finally {
      setOpening(false);
    }
  };
  return (
    <button
      type="button"
      className={styles.iconButton}
      title="Gateway console"
      aria-label="Open gateway console"
      disabled={opening}
      onClick={() => void open()}
    >
      <HugeiconsIcon icon={Globe02Icon} size={18} strokeWidth={1.8} />
    </button>
  );
}

/** Balance pill; an amber dot (reason in the tooltip) when something blocks paid use. */
function CreditsButton({ credits, onClick }: { credits: string; onClick: () => void }) {
  const balance = formatCredits(credits);
  const balanceKnown = useUiSelector((state) => state.creditsBalanceKnown);
  const funding = useFundingStatus();
  const blocked = funding.tone === 'warning';
  if (!balanceKnown) {
    return (
      <button type="button" className={styles.credits} title="Add credits" aria-label="Add credits, loading balance" onClick={onClick}>
        <Skeleton className={styles.creditsSkeleton} />
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`${styles.credits}${blocked ? ` ${styles.creditsBlocked}` : ''}`}
      title={blocked ? `${funding.title}. Click to add credits.` : 'Add credits'}
      aria-label={blocked ? `Balance $${balance}. ${funding.title}. Add credits` : `Add credits, balance $${balance}`}
      onClick={onClick}
    >
      {blocked ? <span className={styles.creditsDot} aria-hidden="true" /> : null}
      ${balance}
    </button>
  );
}
