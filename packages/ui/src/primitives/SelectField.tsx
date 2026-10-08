import { useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import { FieldMessage, fieldClasses, inputClasses, type FieldSize } from './TextField';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'size'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  options: SelectOption[];
  onChange: (value: string) => void;
  size?: FieldSize;
}

/** Native select with the shared field styling. */
export function SelectField({ label, hint, error, options, onChange, className, id, size, ...rest }: SelectFieldProps) {
  const autoId = useId();
  const selectId = id ?? autoId;
  return (
    <label className={fieldClasses(className, size)} htmlFor={selectId}>
      {label && <span className="as-field__label">{label}</span>}
      <select id={selectId} className={inputClasses('as-field__select', false)} onChange={(event) => onChange(event.target.value)} {...rest}>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
        ))}
      </select>
      <FieldMessage error={error} hint={hint} />
    </label>
  );
}
