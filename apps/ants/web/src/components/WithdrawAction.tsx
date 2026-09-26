import { EarlyExitHelp } from './EarlyExitHelp';
import { Button } from './ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { WithdrawRequest } from '../../../src/api-types';
import { api, type WithdrawPreview } from '../api';
import { describeError, formatAnts, formatBps } from '../format';
import { useJobs } from '../jobs';
import { Confirm, useActionBlock } from './Confirm';
import { Spinner } from './Feedback';
import { Facts } from './Panel';

interface Props {
  /** Single position, or several via `positionIds` (bulk withdraw from the positions table). */
  positionId?: number;
  positionIds?: number[];
  size?: 'sm';
  /** Open the preview immediately instead of waiting for the button (row-level withdraw). */
  autoOpen?: boolean;
  onStarted?: () => void;
  onCancel?: () => void;
}

/** Withdraw flow: preview first (synchronous), then an explicit slashing acknowledgement when exiting early. */
export function WithdrawAction({ positionId, positionIds, size, autoOpen = false, onStarted, onCancel }: Props) {
  const ids = positionIds ?? (positionId !== undefined ? [positionId] : []);
  const jobs = useJobs();
  const block = useActionBlock();
  const [open, setOpen] = useState(autoOpen);
  const [preview, setPreview] = useState<WithdrawPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const disabled = ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0);

  const loadPreview = async () => {
    if (disabled) return;
    setLoadingPreview(true);
    setPreview(null);
    setPreviewError(null);
    setAccepted(false);
    try {
      const result = await api.withdrawPreview(ids);
      setPreview(ids.length === 1 ? singlePositionPreview(result, ids[0]!) : result);
    } catch (err) {
      setPreviewError(describeError(err));
    } finally {
      setLoadingPreview(false);
    }
  };

  const onOpen = () => {
    if (disabled) return;
    setOpen(true);
    setError(null);
    void loadPreview();
  };

  useEffect(() => {
    if (autoOpen && !disabled) onOpen();
    // Only on mount: the caller remounts this component per position selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onConfirm = async () => {
    if (!canConfirm || !preview || submitting.current) return;
    const body: WithdrawRequest = {
      positionIds: ids,
      acceptSlashing: preview.earlyExit && accepted,
      maxSlashedAmount: preview.totalSlashed,
    };
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await jobs.start('/api/positions/withdraw', body);
      setOpen(false);
      onStarted?.();
    } catch (err) {
      jobs.pushToast({ tone: 'danger', title: `Withdraw · position${ids.length > 1 ? 's' : ''} ${ids.map(id => `#${id}`).join(', ')} failed`, body: describeError(err), sticky: true });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const reason = block.reason ?? (disabled ? 'Choose at least one position to withdraw.' : undefined);
  const canConfirm = !disabled && !block.blocked && !busy && preview !== null && !preview.simulationError && (!preview.earlyExit || accepted);

  return (
    <div className="action">
      {open && autoOpen ? null : (
        <span className="btn-wrap" title={reason}>
          <Button variant="outline" size={size === 'sm' ? 'sm' : 'md'} onClick={onOpen} disabled={disabled}>
            Withdraw
          </Button>
        </span>
      )}
      {open ? (
        <Confirm
          title={ids.length > 1 ? `Withdraw ${ids.length} positions` : 'Withdraw position'}
          hideTitle={autoOpen}
          confirmLabel={block.label ?? (preview?.earlyExit ? 'Withdraw and burn slashed principal' : 'Withdraw')}
          danger={preview?.earlyExit === true}
          disabled={!canConfirm}
          busy={busy}
          error={error}
          onConfirm={() => {
            void onConfirm();
          }}
          onCancel={() => {
            setOpen(false);
            onCancel?.();
          }}
        >
          {block.reason ? <div className="hint">{block.reason} You can still review this estimate.</div> : null}
          {loadingPreview ? (
            <div className="muted small">
              <Spinner /> Computing slashing preview…
            </div>
          ) : null}
          {previewError ? (
            <div>
              <div className="error-text">{previewError}</div>
              <div className="mt">
                <Button variant="outline" size="sm" onClick={() => void loadPreview()}>
                  Retry preview
                </Button>
              </div>
            </div>
          ) : null}
          {preview?.simulationError && <div className="error-text">Withdrawal cannot execute: {preview.simulationError}</div>}
          {preview ? <div className="hint">Rewards to claim separately: {formatAnts(preview.pendingRewards, 4)} ANTS. {preview.transfersRestricted ? 'Returned ANTS remain transfer-restricted in this wallet. Ending a position does not enable token transfers. Consider moving your allocation directly to another seller.' : 'ANTS transfers are currently enabled for this wallet.'}</div> : null}
          {preview ? (
            <div className="stack">
              <WithdrawalDetails preview={preview} />
              {preview.earlyExit ? (
                <div className="row"><label className="check danger">
                  <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
                  <span>
                    I accept burning <span className="mono">{formatAnts(preview.totalSlashed, 4)}</span> ANTS of principal (early exit).
                  </span>
                </label><EarlyExitHelp /></div>
              ) : (
                <div className="hint">No early-exit penalty applies. Withdrawal returns principal; rewards must be claimed separately.<EarlyExitHelp /></div>
              )}
            </div>
          ) : null}
        </Confirm>
      ) : null}
    </div>
  );
}

export function singlePositionPreview(preview: WithdrawPreview, positionId: number): WithdrawPreview {
  if (preview.positions.length !== 1 || preview.positions[0]?.id !== positionId) throw new Error('Withdrawal preview does not match this position. Refresh and try again.');
  return preview;
}

export function WithdrawalDetails({ preview }: { preview: WithdrawPreview }) {
  const single = preview.positions.length === 1;
  return <Facts items={[
    ...(single
      ? [['Early-exit penalty', <span className={preview.earlyExit ? 'danger' : undefined}>{formatBps(preview.positions[0]!.slashBps)}<EarlyExitHelp /></span>] as [string, ReactNode]]
      : preview.positions.map((position): [string, ReactNode] => [`Position #${position.id}`, <span className={position.slashBps > 0 ? 'danger' : undefined}>{formatAnts(position.amount, 4)} ANTS · penalty {formatBps(position.slashBps)}</span>])),
    ['Burned', <span className={preview.earlyExit ? 'danger' : undefined}>{formatAnts(preview.totalSlashed, 4)} ANTS</span>],
    ['You receive', `${formatAnts(preview.totalReturned, 4)} ANTS`],
  ]} />;
}
