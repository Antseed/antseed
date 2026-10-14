import FocusLock from 'react-focus-lock';
import { RemoveScroll } from 'react-remove-scroll';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useDialogBehavior } from './useDialogBehavior';

export type DrawerSide = 'left' | 'right';

export interface DrawerProps {
  backdropClassName?: string;
  bodyClassName?: string;
  children: ReactNode;
  className?: string;
  closeLabel?: string;
  eyebrow?: ReactNode;
  isOpen: boolean;
  onClose: () => void;
  side?: DrawerSide;
  subtitle?: ReactNode;
  title: ReactNode;
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function Drawer({
  backdropClassName,
  bodyClassName,
  children,
  className,
  closeLabel = 'Close',
  eyebrow,
  isOpen,
  onClose,
  side = 'right',
  subtitle,
  title,
}: DrawerProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const subtitleId = useId();
  const { closeDialog: closeDrawer, isTopDialog } = useDialogBehavior(isOpen, panelRef, onClose);
  const isActiveDialog = isOpen && isTopDialog;

  const backdropClasses = [
    'as-drawer-backdrop',
    isOpen ? 'as-drawer-backdrop--open' : null,
    backdropClassName,
  ].filter(Boolean).join(' ');
  const drawerClasses = [
    'as-drawer',
    `as-drawer--${side}`,
    isOpen ? 'as-drawer--open' : null,
    className,
  ].filter(Boolean).join(' ');
  const bodyClasses = ['as-drawer__body', bodyClassName].filter(Boolean).join(' ');

  useEffect(() => {
    if (!isOpen || !isTopDialog) return;

    function onPointerDown(event: PointerEvent) {
      const panel = panelRef.current;
      if (!panel) return;
      if (event.target instanceof Node && panel.contains(event.target)) return;
      if (
        event.target instanceof Element &&
        // Dialogs and menus opened from the drawer render in portals; using them must not close it.
        event.target.closest('[role="dialog"], [role="menu"]') !== null
      ) {
        return;
      }
      closeDrawer();
    }

    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [closeDrawer, isOpen, isTopDialog]);

  return (
    <>
      <div
        aria-hidden={!isOpen}
        className={backdropClasses}
        onClick={closeDrawer}
      />
      <RemoveScroll
        allowPinchZoom
        className="as-drawer__scroll-lock"
        enabled={isOpen && isTopDialog}
      >
        <FocusLock
          autoFocus
          className="as-drawer__focus-lock"
          disabled={!isOpen || !isTopDialog}
          focusOptions={{ preventScroll: true }}
          returnFocus={false}
        >
          <aside
            aria-describedby={subtitle ? subtitleId : undefined}
            aria-hidden={isActiveDialog ? undefined : true}
            aria-labelledby={titleId}
            aria-modal={isActiveDialog ? 'true' : undefined}
            className={drawerClasses}
            ref={panelRef}
            role="dialog"
            tabIndex={-1}
          >
            <header className="as-drawer__header">
              <div className="as-drawer__titles">
                {eyebrow && <div className="as-drawer__eyebrow">{eyebrow}</div>}
                <h2 className="as-drawer__title" id={titleId}>{title}</h2>
                {subtitle && <p className="as-drawer__subtitle" id={subtitleId}>{subtitle}</p>}
              </div>
              <button type="button" className="as-drawer__close" onClick={closeDrawer} aria-label={closeLabel}>
                <CloseIcon />
              </button>
            </header>
            <div className={bodyClasses}>{children}</div>
          </aside>
        </FocusLock>
      </RemoveScroll>
    </>
  );
}
