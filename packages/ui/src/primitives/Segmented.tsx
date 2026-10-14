import type { ReactNode } from 'react';
import { focusSibling, rovingIndex } from './roving';

export interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: ReactNode; disabled?: boolean }>;
  /** Accessible name of the group. */
  label: string;
  className?: string;
}

/** A single-choice button group (radio semantics, arrow keys move the choice). */
export function Segmented<T extends string>({ value, onChange, options, label, className }: SegmentedProps<T>) {
  const selected = Math.max(0, options.findIndex((option) => option.value === value));
  return (
    <div className={['as-segmented', className].filter(Boolean).join(' ')} role="radiogroup" aria-label={label}>
      {options.map((option, index) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={index === selected ? 0 : -1}
            disabled={option.disabled}
            className={on ? 'as-segmented__item as-segmented__item--on' : 'as-segmented__item'}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              const next = rovingIndex(event, index, options.length);
              if (next === null) return;
              event.preventDefault();
              const target = options[next];
              if (!target || target.disabled) return;
              onChange(target.value);
              focusSibling(event, next, '.as-segmented__item');
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
