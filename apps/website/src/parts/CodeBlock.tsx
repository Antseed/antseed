import type {JSX} from 'react';
import clsx from 'clsx';
import {useCopy} from '../lib/useCopy';
import {CopyMark} from './CopyMark';
import styles from './CodeBlock.module.css';

type Props = {
  code: string;
  /** A file path or a caption over the block. */
  label?: string;
  /** Example output: quieter, without a copy button. */
  output?: boolean;
  className?: string;
};

/** A block of code or commands in the site's command-line style, copied whole by its button. */
export function CodeBlock({code, label, output, className}: Props): JSX.Element {
  const {copied, copy} = useCopy();
  return (
    <figure className={clsx(styles.block, output && styles.output, className)}>
      {label && <figcaption className={styles.label}>{label}</figcaption>}
      <div className={styles.frame}>
        <pre className={styles.pre} tabIndex={0}><code>{code}</code></pre>
        {!output && (
          <button type="button" className={styles.copy} onClick={() => copy(code)} aria-label={copied ? 'Copied' : 'Copy code'}>
            <CopyMark done={copied} size={14} />
            <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
          </button>
        )}
      </div>
    </figure>
  );
}
