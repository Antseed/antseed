import { useState } from 'react';
import { useConfig } from '../app-context';
import { explorerAddressUrl, explorerTxUrl, shortAddress, shortHash } from '../format';

interface Props {
  value: string;
  kind?: 'address' | 'tx';
  short?: boolean;
  label?: string;
  copy?: boolean;
  className?: string;
}

/** Address / tx hash in monospace, linked to the block explorer when the chain has one. */
export function AddressLink({ value, kind = 'address', short = true, label, copy = false, className }: Props) {
  const { evmChainId } = useConfig();
  const url = kind === 'tx' ? explorerTxUrl(evmChainId, value) : explorerAddressUrl(evmChainId, value);
  const text = label ?? (short ? (kind === 'tx' ? shortHash(value) : shortAddress(value)) : value);
  const classes = `mono ${className ?? ''}`.trim();
  return (
    <span className="nowrap">
      {url ? (
        <a className={classes} href={url} target="_blank" rel="noreferrer" title={value}>
          {text}
        </a>
      ) : (
        <span className={classes} title={value}>
          {text}
        </span>
      )}
      {copy ? <CopyButton value={value} /> : null}
    </span>
  );
}

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  };
  return (
    <button className="link-button" style={{ marginLeft: 6 }} onClick={onCopy} type="button" title="Copy">
      {copied ? 'copied' : 'copy'}
    </button>
  );
}
