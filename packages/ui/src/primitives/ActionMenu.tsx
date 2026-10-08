import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ActionMenuItem {
  label: ReactNode;
  onSelect: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
}

export interface ActionMenuProps {
  /** Accessible name of the trigger, e.g. "Actions for Production key". */
  label: string;
  items: Array<ActionMenuItem | null | false | undefined>;
  /** Trigger content; a vertical "more" icon by default. */
  trigger?: ReactNode;
  className?: string;
}

function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="12" cy="19" r="1.7" />
    </svg>
  );
}

const MENU_WIDTH = 176;

/**
 * A kebab menu for row actions. The list renders in a portal with fixed
 * positioning, so scrolling table wrappers never clip it. Arrow keys move,
 * Escape closes and returns focus to the trigger.
 */
export function ActionMenu({ label, items, trigger, className }: ActionMenuProps) {
  const entries = items.filter(Boolean) as ActionMenuItem[];
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const close = useCallback((focusTrigger: boolean) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const height = entries.length * 34 + 10;
    const below = rect.bottom + 4 + height <= window.innerHeight;
    const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
    setPosition(below ? { top: rect.bottom + 4, left } : { top: Math.max(8, rect.top - 4 - height), left });
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [open, entries.length]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onScroll = () => close(false);
    document.addEventListener('mousedown', onPointer);
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close]);

  if (entries.length === 0) return null;

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      buttons[(index + 1) % buttons.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      buttons[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      buttons[buttons.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      close(false);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={['as-icon-button', 'as-action-menu__trigger', className].filter(Boolean).join(' ')}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {trigger ?? <MoreIcon />}
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          className="as-action-menu"
          style={{ ...position, width: MENU_WIDTH }}
          onKeyDown={onMenuKey}
          onClick={(event) => event.stopPropagation()}
        >
          {entries.map((item, index) => (
            <button
              key={index}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              className={item.tone === 'danger' ? 'as-action-menu__item as-action-menu__item--danger' : 'as-action-menu__item'}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
