import { HugeiconsIcon } from '@hugeicons/react';
import { HelpCircleIcon, Key01Icon } from '@hugeicons/core-free-icons';
import type { ViewName } from '../../types';
import styles from './VprHeaderActions.module.scss';
import { openGatewayConsole } from '../../../modules/app/console-launch';

type Props = {
  onSelectView?: (view: ViewName) => void;
  className?: string;
};

export function VprHeaderActions({ onSelectView, className }: Props) {
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
        className={styles.keysButton}
        title="Manage API keys in your gateway"
        aria-label="API keys"
        onClick={() => { void openGatewayConsole('/keys'); }}
      >
        <HugeiconsIcon icon={Key01Icon} size={15} strokeWidth={1.8} />
        API keys
      </button>
    </div>
  );
}
