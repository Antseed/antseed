import React, {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import clsx from 'clsx';
import {useCodeBlockContext} from '@docusaurus/theme-common/internal';
import Container from '@theme/CodeBlock/Container';
import Title from '@theme/CodeBlock/Title';
import Content from '@theme/CodeBlock/Content';
import type {Props} from '@theme/CodeBlock/Layout';
import {CheckIcon, CopyIcon} from '@site/src/components/CopyIcons';
import styles from './styles.module.css';

/* Header label per fence language. Unlisted languages show as-is. */
const LANGUAGE_LABELS: Record<string, string> = {
  bash: 'Terminal',
  sh: 'Terminal',
  shell: 'Terminal',
  json: 'JSON',
  text: 'Text',
  typescript: 'TypeScript',
  ts: 'TypeScript',
  js: 'JavaScript',
  javascript: 'JavaScript',
  http: 'HTTP',
  yaml: 'YAML',
};

const TERMINAL_LANGUAGES = new Set(['bash', 'sh', 'shell']);

/* hugeicons:command-line (16) */
function TerminalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 8L8.84 9.59C9.61 10.25 10 10.58 10 11C10 11.42 9.61 11.75 8.84 12.41L7 14" />
      <path d="M11 15H14" />
      <path d="M2.5 12C2.5 7.52 2.5 5.28 3.89 3.89C5.28 2.5 7.52 2.5 12 2.5C16.48 2.5 18.72 2.5 20.11 3.89C21.5 5.28 21.5 7.52 21.5 12C21.5 16.48 21.5 18.72 20.11 20.11C18.72 21.5 16.48 21.5 12 21.5C7.52 21.5 5.28 21.5 3.89 20.11C2.5 18.72 2.5 16.48 2.5 12Z" />
    </svg>
  );
}

/* hugeicons:file-01 (16) */
function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12.83V11.17C4 7.4 4 5.51 5.17 4.34C6.34 3.17 8.23 3.17 12 3.17C15.77 3.17 17.66 3.17 18.83 4.34C20 5.51 20 7.4 20 11.17V12.83C20 16.6 20 18.49 18.83 19.66C17.66 20.83 15.77 20.83 12 20.83C8.23 20.83 6.34 20.83 5.17 19.66C4 18.49 4 16.6 4 12.83Z" />
      <path d="M8 8H16M8 12H16M8 16H12" />
    </svg>
  );
}

function CopyButton(): ReactNode {
  const {metadata} = useCodeBlockContext();
  const [copied, setCopied] = useState(false);
  const timeout = useRef<number | undefined>(undefined);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(metadata.code).then(() => {
      setCopied(true);
      window.clearTimeout(timeout.current);
      timeout.current = window.setTimeout(() => setCopied(false), 1500);
    });
  }, [metadata.code]);

  useEffect(() => () => window.clearTimeout(timeout.current), []);

  return (
    <button
      type="button"
      className={clsx(styles.copyButton, copied && styles.copyButtonCopied)}
      onClick={copy}
      aria-label={copied ? 'Copied' : 'Copy code to clipboard'}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

export default function CodeBlockLayout({className}: Props): ReactNode {
  const {metadata} = useCodeBlockContext();
  const language = metadata.language ?? 'text';
  const label = LANGUAGE_LABELS[language] ?? language;

  return (
    <Container as="div" className={clsx(className, metadata.className, styles.block)}>
      <div className={styles.header}>
        <span className={styles.label}>
          {TERMINAL_LANGUAGES.has(language) ? <TerminalIcon /> : <FileIcon />}
          {metadata.title ? <Title>{metadata.title}</Title> : label}
        </span>
        {metadata.title && <span className={styles.language}>{label}</span>}
        <CopyButton />
      </div>
      <div className={styles.content}>
        <Content />
      </div>
    </Container>
  );
}
