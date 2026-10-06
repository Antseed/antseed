import { Button, Card } from './ui';
import { Modal } from '@antseed/ui';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../app-context';
import { describeError } from '../format';
import { useJobs } from '../jobs';
import { useWalletReadiness } from '../wallet-readiness';

export type Summary = Array<[string, ReactNode]>;

const ActionDialogContext = createContext<{ current: boolean } | null>(null);
const useDialogLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

export function ActionDialog({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const childBusy = useRef(false);
  const ownBusy = useRef(busy);
  useDialogLayoutEffect(() => { ownBusy.current = busy; }, [busy]);
  const [trigger] = useState(() => typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => () => {
    queueMicrotask(() => {
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    });
  }, [trigger]);
  const dialog = (
    <Modal isOpen title={title} size="lg" overlayClassName="ants-stake-overlay ants-action-overlay" onClose={() => {
      if (!ownBusy.current && !childBusy.current) onClose();
    }}>
      <ActionDialogContext.Provider value={childBusy}>{children}</ActionDialogContext.Provider>
    </Modal>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

interface ConfirmProps {
  title: string;
  hideTitle?: boolean;
  summary?: Summary;
  children?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  disabled?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  embedded?: boolean;
  cancelLabel?: string;
}

export function Confirm({ title, hideTitle = false, summary, children, confirmLabel = 'Confirm', danger, disabled, busy, error, onConfirm, onCancel, embedded, cancelLabel = 'Cancel' }: ConfirmProps) {
  const parentBusy = useContext(ActionDialogContext);
  const inline = embedded || parentBusy !== null;
  useDialogLayoutEffect(() => {
    if (parentBusy) parentBusy.current = busy === true;
    return () => { if (parentBusy) parentBusy.current = false; };
  }, [busy, parentBusy]);
  const content = (
    <Card className="confirm" tone={danger ? 'danger' : 'surface'} role="region" aria-label={title}>
      {inline && !hideTitle ? <div className="confirm-title">{title}</div> : null}
      {summary && summary.length > 0 ? (
        <dl className="facts">
          {summary.map(([label, value], index) => (
            <SummaryRow key={`${label}-${index}`} label={label} value={value} />
          ))}
        </dl>
      ) : null}
      {children}
      {error ? <div className="error-text">{error}</div> : null}
      <div className="confirm-actions">
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={disabled || busy}>
          {busy ? 'Sending…' : confirmLabel}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
      </div>
    </Card>
  );
  return inline ? content : <ActionDialog title={title} onClose={onCancel} busy={busy}>{content}</ActionDialog>;
}

function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

export interface ActionButtonProps {
  label: string;
  title?: string;
  summary?: Summary;
  path: string;
  body: unknown;
  /** Return an error message to block opening the confirm panel. */
  validate?: () => string | null;
  disabled?: boolean;
  disabledReason?: string;
  variant?: 'primary' | 'default' | 'danger';
  size?: 'sm';
  confirmLabel?: string;
  /** Keep the confirm panel open but block its Confirm button (e.g. a required select has no options yet). */
  confirmDisabled?: boolean;
  children?: ReactNode;
  onStarted?: () => void;
}

/** Hook describing why actions are blocked (read-only wallet or a job already running). */
export function useActionBlock(buyerAction = false): { blocked: boolean; reason: string | undefined; label?: string } {
  const { config: { readOnly, selectedAddress, walletAddress, browserWallet }, overview, overviewError } = useApp();
  const { running } = useJobs();
  const readiness = useWalletReadiness();
  if (browserWallet && !readiness) return { blocked: true, label: 'Connect wallet', reason: 'Connect wallet before submitting a transaction.' };
  if (readiness?.reason) return { blocked: true, reason: readiness.reason, label: readiness.label };
  if (readOnly) return { blocked: true, reason: 'Read-only mode: no wallet is available to sign.' };
  if (selectedAddress && !buyerAction && selectedAddress.toLowerCase() !== walletAddress?.toLowerCase()) return { blocked: true, reason: `Connect the selected account wallet ${selectedAddress} for seller and staking actions.` };
  if (!overview || overviewError) return { blocked: true, reason: 'Wallet information is unavailable. Refresh before sending a transaction.' };
  if (BigInt(overview.wallet.signingWalletEth ?? overview.wallet.eth) === 0n) return { blocked: true, reason: 'The signing wallet needs ETH on the selected network for transaction fees.' };
  if (running) return { blocked: true, reason: 'Another action is still running.' };
  return { blocked: false, reason: undefined };
}

export function ActionButton(props: ActionButtonProps) {
  const jobs = useJobs();
  const body = props.body as { scope?: string; side?: string } | null;
  const buyerAction = (props.path === '/api/rewards/claim' && body?.scope === 'buyer') || (props.path === '/api/rewards/stake-usage' && body?.side === 'buyer');
  const block = useActionBlock(buyerAction);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const parentBusy = useContext(ActionDialogContext);

  const skipConfirmation = !props.children;
  const blocked = block.blocked || props.disabled === true;
  const reason = block.reason ?? (props.disabled ? props.disabledReason : undefined);

  const onClick = async () => {
    if (blocked || submitting.current || (skipConfirmation && props.confirmDisabled)) return;
    const problem = props.validate?.() ?? null;
    setError(problem);
    if (problem !== null) return;
    if (skipConfirmation) await onConfirm();
    else setOpen(true);
  };

  const onConfirm = async () => {
    if (blocked || props.confirmDisabled || submitting.current) return;
    const problem = props.validate?.() ?? null;
    if (problem !== null) { setError(problem); return; }
    submitting.current = true;
    if (skipConfirmation && parentBusy) parentBusy.current = true;
    setBusy(true);
    setError(null);
    try {
      await jobs.start(props.path, props.body);
      setOpen(false);
      props.onStarted?.();
    } catch (err) {
      jobs.pushToast({ tone: 'danger', title: `${props.title ?? props.label} failed`, body: describeError(err), sticky: true });
    } finally {
      submitting.current = false;
      if (skipConfirmation && parentBusy) parentBusy.current = false;
      setBusy(false);
    }
  };

  const variant = props.variant === 'primary' ? 'primary' : props.variant === 'danger' ? 'danger' : 'outline';

  return (
    <div className="action">
      {!open ? <span className="btn-wrap" title={reason}>
        <Button variant={variant} size={props.size === 'sm' ? 'sm' : 'md'} onClick={onClick} disabled={blocked || busy || (skipConfirmation && props.confirmDisabled)}>
          {busy && skipConfirmation ? 'Sending…' : block.label ?? props.label}
        </Button>
      </span> : null}
      {error && !open ? <div className="error-text">{error}</div> : null}
      {open ? (
        <Confirm
          title={props.title ?? props.label}
          summary={props.summary}
          confirmLabel={block.label ?? props.confirmLabel ?? props.label}
          danger={props.variant === 'danger'}
          disabled={blocked || props.confirmDisabled}
          busy={busy}
          error={error}
          onConfirm={() => {
            void onConfirm();
          }}
          onCancel={() => {
            setOpen(false);
            setError(null);
          }}
        >
          {props.children}
        </Confirm>
      ) : null}
    </div>
  );
}
