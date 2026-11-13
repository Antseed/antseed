import type { ReactNode } from 'react';
import { Alert } from './Alert';
import { Button } from './Button';
import { Modal } from './Modal';

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: ReactNode;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  busyLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  /** An Error, a message, or a rendered node; shown above the buttons. */
  error?: unknown;
  errorTitle?: ReactNode;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

function errorContent(error: unknown): ReactNode {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return 'Something went wrong.';
}

export function ConfirmDialog({
  isOpen,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  busyLabel = 'Working…',
  tone = 'danger',
  busy,
  error,
  errorTitle = 'That did not work',
  confirmDisabled,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <Modal isOpen={isOpen} onClose={busy ? () => {} : onClose} title={title} size="sm">
      <div className="as-confirm">
        <div className="as-confirm__body">{body}</div>
        {error ? <Alert tone="danger" title={errorTitle}>{errorContent(error)}</Alert> : null}
        <div className="as-confirm__actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>{cancelLabel}</Button>
          <Button variant={tone} onClick={onConfirm} disabled={busy || confirmDisabled}>{busy ? busyLabel : confirmLabel}</Button>
        </div>
      </div>
    </Modal>
  );
}
