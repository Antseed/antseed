import FocusLock from 'react-focus-lock';
import { RemoveScroll } from 'react-remove-scroll';
import { useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { useDialogBehavior } from './useDialogBehavior';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ModalProps {
  bodyClassName?: string;
  children: ReactNode;
  closeLabel?: string;
  className?: string;
  eyebrow?: ReactNode;
  /** Actions pinned to the bottom of the dialog while the body scrolls (e.g. Cancel / Save). */
  footer?: ReactNode;
  isOpen: boolean;
  onClose: () => void;
  overlayClassName?: string;
  size?: ModalSize;
  subtitle?: ReactNode;
  title: ReactNode;
}

const modalWidths: Record<ModalSize, string> = {
  sm: '24rem',
  md: '28.75rem',
  lg: '35rem',
  xl: '52rem',
};
function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function Modal({
  bodyClassName,
  children,
  className,
  closeLabel = 'Close',
  eyebrow,
  footer,
  isOpen,
  onClose,
  overlayClassName,
  size = 'md',
  subtitle,
  title,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const subtitleId = useId();
  const { closeDialog: closeModal, isTopDialog } = useDialogBehavior(isOpen, panelRef, onClose);

  if (!isOpen) return null;

  const overlayClasses = ['as-modal-overlay', overlayClassName].filter(Boolean).join(' ');
  const modalClasses = ['as-modal', `as-modal--${size}`, className].filter(Boolean).join(' ');
  const bodyClasses = ['as-modal__body', bodyClassName].filter(Boolean).join(' ');
  const scrollLockStyle = { '--as-modal-width': modalWidths[size] } as CSSProperties;

  return (
    <div className={overlayClasses} role="presentation" onMouseDown={closeModal}>
      <RemoveScroll
        allowPinchZoom
        className="as-modal__scroll-lock"
        enabled={isTopDialog}
        style={scrollLockStyle}
      >
        <FocusLock
          autoFocus
          className="as-modal__focus-lock"
          disabled={!isTopDialog}
          focusOptions={{ preventScroll: true }}
          returnFocus={false}
        >
          <div
            aria-describedby={subtitle ? subtitleId : undefined}
            aria-hidden={isTopDialog ? undefined : true}
            aria-labelledby={titleId}
            aria-modal={isTopDialog ? 'true' : undefined}
            className={modalClasses}
            ref={panelRef}
            role="dialog"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="as-modal__header">
              <div className="as-modal__titles">
                {eyebrow && <div className="as-modal__eyebrow">{eyebrow}</div>}
                <h2 className="as-modal__title" id={titleId}>{title}</h2>
                {subtitle && <p className="as-modal__subtitle" id={subtitleId}>{subtitle}</p>}
              </div>
              <IconButton label={closeLabel} className="as-modal__close" onClick={closeModal}>
                <CloseIcon />
              </IconButton>
            </header>
            <div className={bodyClasses}>{children}</div>
            {footer && <footer className="as-modal__footer">{footer}</footer>}
          </div>
        </FocusLock>
      </RemoveScroll>
    </div>
  );
}

function IconButton({
  children,
  className,
  label,
  onClick,
}: {
  children: ReactNode;
  className: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={className} onClick={onClick} aria-label={label}>
      {children}
    </button>
  );
}
