import { HugeiconsIcon } from '@hugeicons/react';
import { HelpCircleIcon, Key01Icon, Settings01Icon } from '@hugeicons/core-free-icons';
import { Skeleton } from '@antseed/ui';
import { formatCredits } from '../../../core/format';
import type { ViewName } from '../../types';
import { useFundingStatus } from '../../hooks/useFundingStatus';
import { useUiSelector } from '../../hooks/useUiSelector';
import { gatewayResource } from '../../../modules/app/vpr-resources';
import { useCachedResource } from '../../../modules/app/cached-resource';
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
      <button
        type="button"
        className={styles.iconButton}
        title="Settings"
        aria-label="Settings"
        onClick={() => onSelectView?.('preferences')}
      >
        <HugeiconsIcon icon={Settings01Icon} size={18} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className={styles.keysButton}
        title="Manage API keys in your gateway"
        aria-label="API keys"
        onClick={() => { void globalThis.window?.antseedDesktop?.gatewayOpenConsole?.('/keys'); }}
      >
        <HugeiconsIcon icon={Key01Icon} size={15} strokeWidth={1.8} />
        API keys
      </button>
      <CreditsButton credits={credits} onClick={() => onSelectView?.('deposit')} />
    </div>
  );
}

/** Balance pill; an amber dot (reason in the tooltip) when something blocks paid use. */
function CreditsButton({ credits, onClick }: { credits: string; onClick: () => void }) {
  const balance = formatCredits(credits);
  const balanceKnown = useUiSelector((state) => state.creditsBalanceKnown);
  const funding = useFundingStatus();
  // A remote gateway pays from its own wallet; this app's balance says nothing about it.
  const remote = useCachedResource(gatewayResource).data?.status.mode === 'remote';
  const blocked = funding.tone === 'warning';
  if (remote) return null;
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
