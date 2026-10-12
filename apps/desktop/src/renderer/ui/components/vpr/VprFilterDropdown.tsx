import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import styles from './VprFilterDropdown.module.scss';

export type VprFilterOption<Value extends string> = {
  value: Value;
  label: string;
  description?: string;
  icon: ReactNode;
};

type Props<Value extends string> = {
  active?: boolean;
  label: string;
  value: Value;
  options: readonly VprFilterOption<Value>[];
  onChange: (value: Value) => void;
  align?: 'start' | 'end';
};

type MultiProps<Value extends string> = {
  label: string;
  values: readonly Value[];
  options: readonly VprFilterOption<Value>[];
  onChange: (values: Value[]) => void;
  emptyIcon?: ReactNode;
};

function useDropdownDismiss(open: boolean, rootRef: React.RefObject<HTMLDivElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    window.addEventListener('pointerdown', dismiss);
    return () => window.removeEventListener('pointerdown', dismiss);
  }, [close, open, rootRef]);
}

function focusOption(root: HTMLDivElement | null, index: number): void {
  const items = root?.querySelectorAll<HTMLButtonElement>('[role="option"]');
  items?.[Math.max(0, Math.min(index, items.length - 1))]?.focus();
}

function handleOptionKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  index: number,
  optionCount: number,
  root: HTMLDivElement | null,
  closeAndFocus: () => void,
): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeAndFocus();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    focusOption(root, (index + (event.key === 'ArrowDown' ? 1 : -1) + optionCount) % optionCount);
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    focusOption(root, event.key === 'Home' ? 0 : optionCount - 1);
  }
}

export function VprFilterDropdown<Value extends string>({
  active,
  label,
  value,
  options,
  onChange,
  align = 'start',
}: Props<Value>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];
  const close = () => setOpen(false);
  useDropdownDismiss(open, rootRef, close);

  function closeAndFocus(): void {
    close();
    buttonRef.current?.focus();
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setOpen(true);
    requestAnimationFrame(() => focusOption(rootRef.current, event.key === 'ArrowDown' ? 0 : options.length - 1));
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <DropdownTrigger
        buttonRef={buttonRef}
        label={label}
        displayLabel={selected.label}
        icon={selected.icon}
        active={active ?? Boolean(value)}
        open={open}
        menuId={menuId}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
      />
      {open && (
        <DropdownMenu id={menuId} label={label} align={align}>
          {options.map((option, index) => {
            const active = option.value === value;
            return (
              <DropdownOption
                key={option.value || '__all'}
                option={option}
                active={active}
                onClick={() => {
                  onChange(option.value);
                  closeAndFocus();
                }}
                onKeyDown={(event) => handleOptionKeyDown(
                  event, index, options.length, rootRef.current, closeAndFocus,
                )}
              />
            );
          })}
        </DropdownMenu>
      )}
    </div>
  );
}

export function VprMultiFilterDropdown<Value extends string>({
  label,
  values,
  options,
  onChange,
  emptyIcon,
}: MultiProps<Value>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const selected = new Set(values);
  const firstOption = options[0];
  const displayLabel = values.length === 0
    ? label
    : values.length === 1
      ? options.find((option) => option.value === values[0])?.label ?? label
      : `${values.length} selected`;
  const close = () => setOpen(false);
  useDropdownDismiss(open, rootRef, close);

  function closeAndFocus(): void {
    close();
    buttonRef.current?.focus();
  }

  function toggle(value: Value): void {
    onChange(selected.has(value)
      ? values.filter((candidate) => candidate !== value)
      : [...values, value]);
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <DropdownTrigger
        buttonRef={buttonRef}
        label={label}
        displayLabel={displayLabel}
        icon={values.length === 1
          ? options.find((option) => option.value === values[0])?.icon ?? emptyIcon ?? firstOption.icon
          : emptyIcon ?? firstOption.icon}
        active={values.length > 0}
        open={open}
        menuId={menuId}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          setOpen(true);
          requestAnimationFrame(() => focusOption(rootRef.current, event.key === 'ArrowDown' ? 0 : options.length - 1));
        }}
      />
      {open && (
        <DropdownMenu id={menuId} label={label} compact>
          {options.map((option, index) => {
            const active = selected.has(option.value);
            return (
              <DropdownOption
                key={option.value || '__all'}
                option={option}
                active={active}
                compact
                onClick={() => toggle(option.value)}
                onKeyDown={(event) => handleOptionKeyDown(
                  event, index, options.length, rootRef.current, closeAndFocus,
                )}
              />
            );
          })}
        </DropdownMenu>
      )}
    </div>
  );
}

function DropdownTrigger({
  buttonRef,
  label,
  displayLabel,
  icon,
  active,
  open,
  menuId,
  onClick,
  onKeyDown,
}: {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  label: string;
  displayLabel: string;
  icon: ReactNode;
  active: boolean;
  open: boolean;
  menuId: string;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`${styles.trigger}${open ? ` ${styles.triggerOpen}` : ''}${active ? ` ${styles.triggerActive}` : ''}`}
      aria-label={label}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={menuId}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <span className={styles.triggerIcon}>{icon}</span>
      <span className={styles.triggerLabel}>{displayLabel}</span>
      <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.8} className={styles.chevron} />
    </button>
  );
}

function DropdownMenu({
  id,
  label,
  align = 'start',
  compact = false,
  children,
}: {
  id: string;
  label: string;
  align?: 'start' | 'end';
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className={`${styles.menu}${align === 'end' ? ` ${styles.menuEnd}` : ''}${compact ? ` ${styles.menuCompact}` : ''}`}
      role="listbox"
      aria-label={label}
      aria-multiselectable={compact || undefined}
    >
      <div className={styles.menuLabel}>{label}</div>
      {children}
    </div>
  );
}

function DropdownOption<Value extends string>({
  option,
  active,
  compact = false,
  onClick,
  onKeyDown,
}: {
  option: VprFilterOption<Value>;
  active: boolean;
  compact?: boolean;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={`${styles.option}${active ? ` ${styles.optionActive}` : ''}${compact ? ` ${styles.optionCompact}` : ''}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <span className={styles.optionIcon}>{option.icon}</span>
      <span className={styles.optionText}>
        <span className={styles.optionLabel}>{option.label}</span>
        {!compact && option.description && <span className={styles.optionDescription}>{option.description}</span>}
      </span>
      {active && <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={2} className={styles.check} />}
    </button>
  );
}
