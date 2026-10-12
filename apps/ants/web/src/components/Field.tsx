import { TextField } from './ui';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

type Width = 'sm' | 'md' | 'lg';

/** Generic labelled field for non-text controls (select, file input). Text inputs use `Input` (shared TextField). */
export function Field({ label, hint, width, children }: { label: string; hint?: ReactNode; width?: Width; children: ReactNode }) {
  return (
    <label className={['field', width ? `field-w-${width}` : ''].filter(Boolean).join(' ')}>
      <span className="field__label">{label}</span>
      {children}
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode; error?: ReactNode; mono?: boolean; width?: Width };

/** Shared TextField with the dashboard's width presets; monospace by default (amounts, ids, addresses). */
export function Input({ mono = true, width = 'md', className, ...rest }: InputProps) {
  const classes = [`field-w-${width}`, className ?? ''].filter(Boolean).join(' ');
  return <TextField className={classes} {...rest} style={mono ? { fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', ...rest.style } : rest.style} />;
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export function Select({ className, children, ...rest }: SelectProps) {
  const classes = ['field__input', className ?? ''].filter(Boolean).join(' ');
  return (
    <span className="select-wrap">
      <select className={classes} {...rest}>
        {children}
      </select>
    </span>
  );
}
