import { useEffect, useRef, useState } from 'react';
import { Button, type ButtonSize, type ButtonVariant } from './Button';
import { IconButton } from './IconButton';

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
}

export interface CopyButtonProps {
  value: string;
  label?: string;
  copiedLabel?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
  className?: string;
  /** Just the icon; `label` becomes its accessible name and tooltip. */
  iconOnly?: boolean;
  /** Called after a successful copy (e.g. to show a toast). */
  onCopied?: () => void;
}

export function CopyButton({ value, label = 'Copy', copiedLabel = 'Copied', size = 'sm', variant = 'outline', className, iconOnly, onCopied }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    if (await copyText(value)) {
      setCopied(true);
      onCopied?.();
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    }
  };
  if (iconOnly) {
    return (
      <IconButton label={copied ? copiedLabel : label} size="sm" className={className} onClick={() => void copy()}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </IconButton>
    );
  }
  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      leadingIcon={copied ? <CheckIcon /> : <CopyIcon />}
      aria-live="polite"
      onClick={() => void copy()}
    >
      {copied ? copiedLabel : label}
    </Button>
  );
}
