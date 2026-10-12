import { HugeiconsIcon } from '@hugeicons/react';
import { HelpCircleIcon, Settings01Icon } from '@hugeicons/core-free-icons';
import { formatCredits } from '../../../core/format';
import type { ViewName } from '../../types';
import { useFundingStatus } from '../../hooks/useFundingStatus';
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
      <CreditsButton credits={credits} onClick={() => onSelectView?.('deposit')} />
    </div>
  );
}

/** Balance pill; an amber dot (reason in the tooltip) when something blocks paid use. */
function CreditsButton({ credits, onClick }: { credits: string; onClick: () => void }) {
  const balance = formatCredits(credits);
  const funding = useFundingStatus();
  const blocked = funding.tone === 'warning';
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
