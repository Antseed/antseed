import {useEffect, useState} from 'react';
import styles from './CommandChip.module.css';

/**
 * Inline shell command shown next to a CTA — mono pill with a copy button.
 * Clicking copies the command (without the "$") and flashes "Copied".
 */
export function CommandChip({command, size = 'lg', dark = false}: {command: string; size?: 'md' | 'lg'; dark?: boolean}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      /* clipboard unavailable — leave the text selectable */
    }
  };
  return (
    <button
      type="button"
      className={`${styles.chip} ${size === 'md' ? styles.md : ''} ${dark ? styles.dark : ''} ${copied ? styles.copied : ''}`}
      onClick={copy}
      aria-label={`Copy command: ${command}`}
      title="Copy to clipboard">
      <span className={styles.prompt} aria-hidden="true">$</span>
      <code className={styles.cmd}>{command}</code>
      <span className={styles.icon} aria-hidden="true">
        {copied ? (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5l3 3 7-7" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="2" /><path d="M10.5 5.5V4a1.5 1.5 0 00-1.5-1.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5" /></svg>
        )}
      </span>
      <span className={styles.toast} aria-live="polite">{copied ? 'Copied' : ''}</span>
    </button>
  );
}
