import { useId, type ReactNode } from 'react';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Switch({ checked, onChange, label, description, disabled, className }: SwitchProps) {
  const id = useId();
  const descriptionId = useId();
  return (
    <div className={['as-switch', className].filter(Boolean).join(' ')}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? descriptionId : undefined}
        disabled={disabled}
        className={checked ? 'as-switch__track as-switch__track--on' : 'as-switch__track'}
        onClick={() => onChange(!checked)}
      >
        <span className="as-switch__thumb" />
      </button>
      <label htmlFor={id} className="as-switch__text">
        <span className="as-switch__label">{label}</span>
        {description && <span id={descriptionId} className="as-switch__desc">{description}</span>}
      </label>
    </div>
  );
}
