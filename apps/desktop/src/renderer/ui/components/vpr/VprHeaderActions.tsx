import { HugeiconsIcon } from '@hugeicons/react';
import { HelpCircleIcon, Settings01Icon } from '@hugeicons/core-free-icons';
import { formatCredits } from '../../../core/format';
import type { ViewName } from '../../types';
import styles from './VprHeaderActions.module.scss';

type Props = {
  credits: string;
  onSelectView?: (view: ViewName) => void;
  className?: string;
};

export function VprHeaderActions({ credits, onSelectView, className }: Props) {
  const balance = formatCredits(credits);
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
        className={styles.credits}
        title="Add credits"
        aria-label={`Add credits, balance $${balance}`}
        onClick={() => onSelectView?.('deposit')}
      >
        ${balance}
      </button>
    </div>
  );
}
