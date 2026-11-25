import type { ReactNode } from 'react';
import { focusSibling, rovingIndex } from './roving';

export interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: ReactNode; disabled?: boolean; title?: string }>;
  /** Accessible name of the group. */
  label: string;
  className?: string;
  /** Extra classes for an option's button, e.g. a per-choice selected look. */
  itemClassName?: (value: T, selected: boolean) => string | undefined;
  /** Leaves the look to `className` / `itemClassName`; the behavior (radio roles, arrow keys) stays. */
  bare?: boolean;
}

/** A single-choice button group (radio semantics, arrow keys move the choice). */
export function Segmented<T extends string>({ value, onChange, options, label, className, itemClassName, bare = false }: SegmentedProps<T>) {
  const selected = Math.max(0, options.findIndex((option) => option.value === value));
  return (
    <div className={[bare ? null : 'as-segmented', className].filter(Boolean).join(' ')} role="radiogroup" aria-label={label}>
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
            title={option.title}
            className={[
              bare ? null : 'as-segmented__item',
              bare || !on ? null : 'as-segmented__item--on',
              itemClassName?.(option.value, on),
            ].filter(Boolean).join(' ') || undefined}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              const next = rovingIndex(event, index, options.length);
              if (next === null) return;
              event.preventDefault();
              const target = options[next];
              if (!target || target.disabled) return;
              onChange(target.value);
              focusSibling(event, next, '[role="radio"]');
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
