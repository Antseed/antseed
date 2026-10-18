import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ActionMenuItem {
  label: ReactNode;
  onSelect: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  /** A second, muted line under the label. */
  description?: ReactNode;
  /** Set on every item to make a single-choice menu: the checked one shows a check mark. */
  checked?: boolean;
  /** Shown before the label, e.g. a brand mark. */
  icon?: ReactNode;
  /** A heading shown above the first item of each run of items with the same section. */
  section?: string;
}

export interface ActionMenuProps {
  /** Accessible name of the trigger, e.g. "Actions for Production key". */
  label: string;
  items: Array<ActionMenuItem | null | false | undefined>;
  /** Trigger content; a vertical "more" icon by default. */
  trigger?: ReactNode;
  className?: string;
  /** 'icon' (default) styles the trigger as an icon button; 'plain' leaves it to `className`, for a text trigger. */
  triggerStyle?: 'icon' | 'plain';
  /** Which edge of the trigger the menu lines up with: 'end' (default) or 'start'. */
  align?: 'start' | 'end';
  /** Menu width in px (default 176). */
  width?: number;
  /**
   * A multiple-choice menu (filters): every item is a checkbox (`checked`), and
   * choosing one keeps the menu open so several can be toggled in a row.
   */
  multiple?: boolean;
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

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/**
 * A kebab menu for row actions. The list renders in a portal with fixed
 * positioning, so scrolling table wrappers never clip it. Arrow keys move,
 * Escape closes and returns focus to the trigger.
 */
export function ActionMenu({ label, items, trigger, className, triggerStyle = 'icon', align = 'end', width = MENU_WIDTH, multiple = false }: ActionMenuProps) {
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
    const sections = entries.filter((item, index) => item.section && item.section !== entries[index - 1]?.section).length;
    const height = Math.min(entries.reduce((sum, item) => sum + (item.description ? 50 : 34), 10 + sections * 28), window.innerHeight - 16);
    const below = rect.bottom + 4 + height <= window.innerHeight;
    const left = Math.max(8, Math.min(align === 'start' ? rect.left : rect.right - width, window.innerWidth - width - 8));
    setPosition({ ...(below ? { top: rect.bottom + 4 } : { top: Math.max(8, rect.top - 4 - height) }), left, maxHeight: height });
    // A single-choice menu opens on the current choice.
    const start = menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]:not([disabled])')
      ?? menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])');
    start?.focus();
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
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])') ?? [])];
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
        className={[triggerStyle === 'icon' ? 'as-icon-button' : null, 'as-action-menu__trigger', className].filter(Boolean).join(' ')}
        aria-label={label}
        title={triggerStyle === 'icon' ? label : undefined}
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
          style={{ ...position, width }}
          onKeyDown={onMenuKey}
          onClick={(event) => event.stopPropagation()}
        >
          {entries.map((item, index) => (
            <Fragment key={index}>
              {item.section && item.section !== entries[index - 1]?.section && (
                <div className="as-action-menu__section" role="presentation">{item.section}</div>
              )}
              <button
                type="button"
                role={item.checked === undefined ? 'menuitem' : multiple ? 'menuitemcheckbox' : 'menuitemradio'}
                aria-checked={item.checked}
                tabIndex={-1}
                disabled={item.disabled}
                className={['as-action-menu__item', item.tone === 'danger' ? 'as-action-menu__item--danger' : null, item.checked !== undefined || item.icon ? 'as-action-menu__item--choice' : null].filter(Boolean).join(' ')}
                onClick={() => {
                  if (!multiple) close(true);
                  item.onSelect();
                }}
              >
                {item.checked !== undefined && <span className="as-action-menu__check">{item.checked ? <CheckIcon /> : null}</span>}
                {item.icon && <span className="as-action-menu__icon" aria-hidden="true">{item.icon}</span>}
                <span className="as-action-menu__text">
                  <span className="as-action-menu__label">{item.label}</span>
                  {item.description && <span className="as-action-menu__description">{item.description}</span>}
                </span>
              </button>
            </Fragment>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
