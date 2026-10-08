import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

export type FieldSize = 'sm' | 'md';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  error?: ReactNode;
  hint?: ReactNode;
  label?: ReactNode;
  /** `sm` for dense toolbars and filters. */
  size?: FieldSize;
  /** Monospace input, for ids, keys and addresses. */
  mono?: boolean;
}

export function fieldClasses(className: string | undefined, size: FieldSize | undefined): string {
  return ['as-field', size === 'sm' ? 'as-field--sm' : null, className].filter(Boolean).join(' ');
}

export function inputClasses(extra: string | null, mono: boolean | undefined): string {
  return ['as-field__input', extra, mono ? 'as-field__input--mono' : null].filter(Boolean).join(' ');
}

/** The line under a field: the error when there is one, else the hint. */
export function FieldMessage({ error, hint }: { error?: ReactNode; hint?: ReactNode }) {
  if (error) return <span className="as-field__error">{error}</span>;
  if (hint) return <span className="as-field__hint">{hint}</span>;
  return null;
}

export function TextField({
  className,
  error,
  hint,
  id,
  label,
  size,
  mono,
  ...rest
}: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? rest.name ?? autoId;

  return (
    <label className={fieldClasses(className, size)} htmlFor={inputId}>
      {label && <span className="as-field__label">{label}</span>}
      <input id={inputId} className={inputClasses(null, mono)} aria-invalid={error ? true : undefined} {...rest} />
      <FieldMessage error={error} hint={hint} />
    </label>
  );
}
