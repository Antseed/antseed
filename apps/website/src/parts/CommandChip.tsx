import type {JSX} from 'react';
import clsx from 'clsx';
import {useCopy} from '../lib/useCopy';
import {CopyMark} from './CopyMark';
import styles from './CommandChip.module.css';

/** The join-buyer skill: the one command that hands an agent Antseed. */
export const JOIN_BUYER_SKILL_COMMAND = 'gh skill install Antseed/antseed join-buyer';

type Props = {
  command: string;
  className?: string;
};

/** A shell command on one line, copied (without the `$`) by a click; "Copied" shows for a moment. */
export function CommandChip({command, className}: Props): JSX.Element {
  const {copied, copy} = useCopy();
  return (
    <button type="button" className={clsx(styles.chip, className)} onClick={() => copy(command)} aria-label={`Copy command: ${command}`} title="Copy to clipboard">
      <span className={styles.prompt} aria-hidden="true">$</span>
      <code className={styles.command}>{command}</code>
      <CopyMark done={copied} size={16} className={styles.mark} />
      <span className={styles.status} aria-live="polite">{copied ? 'Copied' : ''}</span>
    </button>
  );
}
