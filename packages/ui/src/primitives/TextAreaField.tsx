import { useId, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { FieldMessage, fieldClasses, inputClasses } from './TextField';

export interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  mono?: boolean;
}

export function TextAreaField({ label, hint, error, className, id, mono, ...rest }: TextAreaFieldProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <label className={fieldClasses(className, 'md')} htmlFor={fieldId}>
      {label && <span className="as-field__label">{label}</span>}
      <textarea id={fieldId} className={inputClasses('as-field__textarea', mono)} aria-invalid={error ? true : undefined} {...rest} />
      <FieldMessage error={error} hint={hint} />
    </label>
  );
}
