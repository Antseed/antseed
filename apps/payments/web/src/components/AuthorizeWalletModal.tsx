import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAccount, useDisconnect } from 'wagmi';
import { ActionModal } from '../layout/ActionModal';
import { useSetOperator } from '../hooks/useSetOperator';
import type { PaymentConfig } from '../types';
import { Button } from './Button';
import { ConnectWalletAction } from './ConnectWalletAction';

interface AuthorizeWalletModalProps {
  isOpen: boolean;
  config: PaymentConfig | null;
  hasPendingAction: boolean;
  onClose: () => void;
  onAuthorized: () => void;
}

export function AuthorizeWalletModal({
  isOpen,
  config,
  hasPendingAction,
  onClose,
  onAuthorized,
}: AuthorizeWalletModalProps) {
  const { address, isConnected, connector } = useAccount();
  const { disconnect, isPending: disconnecting, error: disconnectError } = useDisconnect();
  const walletConnected = isConnected && Boolean(address);
  const { run, running, success, error, reset } = useSetOperator(config);

  const whyRef = useRef<HTMLDivElement>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);

  const showTooltip = () => {
    const rect = whyRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltipPos({ top: rect.bottom + 8, left: rect.left });
  };
  const hideTooltip = () => setTooltipPos(null);

  useEffect(() => {
    if (success) {
      onAuthorized();
      reset();
    }
  }, [success, onAuthorized, reset]);

  useEffect(() => {
    if (!isOpen) {
      reset();
      setTooltipPos(null);
    }
  }, [isOpen, reset]);

  return (
    <ActionModal
      isOpen={isOpen}
      onClose={onClose}
      title="Authorize your wallet"
      subtitle="Required to withdraw USDC, claim ANTS, and close channels."
    >
      <div className="authorize-wallet-modal">
        <div
          ref={whyRef}
          className="authorize-wallet-why"
          tabIndex={0}
          onMouseEnter={showTooltip}
          onMouseLeave={hideTooltip}
          onFocus={showTooltip}
          onBlur={hideTooltip}
        >
          <span>Why you need an authorized wallet</span>
          <span className="authorize-wallet-why-icon" aria-hidden="true">?</span>
        </div>
        {tooltipPos && createPortal(
          <div
            className="authorize-wallet-why-tooltip"
            role="tooltip"
            style={{ top: tooltipPos.top, left: tooltipPos.left }}
          >
            <p>
              Your AntSeed signer lives on this node and authorizes spending, but it
              never holds USDC or ANTS. To <strong>withdraw funds</strong>,{' '}
              <strong>claim ANTS rewards</strong>, or{' '}
              <strong>close a channel</strong>, you need to designate an external
              wallet that the contracts will trust.
            </p>
            <p>
              Without an authorized wallet, if you lose access to this node (deleted{' '}
              <code>.antseed</code> directory, lost machine, etc.) your funds are{' '}
              <strong>unrecoverable</strong>. Set this now to keep your funds safe.
            </p>
          </div>,
          document.body,
        )}

        {!walletConnected ? (
          <div className="authorize-wallet-connect">
            <div className="authorize-wallet-step-label">Step 1 — Connect a wallet</div>
            <ConnectWalletAction>
              {({ openConnectModal, ready, connected }) => connected ? null : (
                <Button
                  fullWidth
                  onClick={openConnectModal}
                  disabled={!ready}
                >
                  Connect wallet
                </Button>
              )}
            </ConnectWalletAction>
          </div>
        ) : (
          <div className="authorize-wallet-connect">
            <div className="authorize-wallet-connected-header">
              <div className="authorize-wallet-step-label">Connected wallet</div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => disconnect({ connector }, { onSuccess: () => reset() })}
                disabled={running || disconnecting}
                title="Disconnect from this page. This does not revoke on-chain authorization."
              >
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </div>
            <div className="authorize-wallet-addr">{address}</div>
          </div>
        )}

        <div className="authorize-wallet-actions">
          <Button
            fullWidth
            onClick={() => void run()}
            disabled={!walletConnected || running || disconnecting || !config}
          >
            {running ? 'Authorizing…' : 'Authorize this wallet'}
          </Button>
          <button
            type="button"
            className="btn-link"
            onClick={onClose}
            disabled={running}
          >
            {hasPendingAction ? 'Cancel' : 'Later'}
          </button>
        </div>

        {error && <div className="status-msg status-error">{error}</div>}
        {disconnectError && <div role="alert" className="status-msg status-error">Could not disconnect: {disconnectError.message}</div>}
      </div>
    </ActionModal>
  );
}
