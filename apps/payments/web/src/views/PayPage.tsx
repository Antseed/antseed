import { useCallback, useEffect, useState } from 'react';
import type { BalanceData, PaymentConfig } from '../types';
import { useAuthorizedWallet } from '../context/AuthorizedWalletContext';
import { PayCheckoutDeposit } from '../components/PayCheckoutDeposit';
import { PayCheckoutWithdraw } from '../components/PayCheckoutWithdraw';
import { PayChannelClose } from '../components/PayChannelClose';
import { openRewardsDashboard } from '../api';
import { Button } from '../components/Button';
import { notifyPaymentCompleted } from '../api';
import { truncateAddress } from '../utils/format';
import { getExplorerTxUrl } from '../utils/txLink';
import './PayPage.scss';

export type PayPageAction = 'deposit' | 'withdraw' | 'authorize' | 'claim' | 'close-channel';

/**
 * 'app' — user's real browser launched chromeless (`--app=`): extension
 *   wallets work. 'win' — Electron popup fallback: WalletConnect/QR only.
 * null — regular browser tab.
 */
export type PayPagePopup = 'app' | 'win' | null;

interface PayPageProps {
  action: PayPageAction;
  amount: string | null;
  channelId: string | null;
  popup: PayPagePopup;
  config: PaymentConfig | null;
  balance: BalanceData | null;
  buyerEvmAddress: string | null;
  refreshBalance: () => Promise<void>;
}

const COPY: Record<PayPageAction, { eyebrow: string; title: string; subtitle: string }> = {
  deposit: {
    eyebrow: 'Adding credits',
    title: 'Deposit USDC',
    subtitle: 'Connect a wallet to add credits to your AntSeed account.',
  },
  withdraw: {
    eyebrow: 'Withdrawing credits',
    title: 'Withdraw USDC',
    subtitle: 'Send unused credits to your authorized wallet.',
  },
  authorize: {
    eyebrow: 'Account security',
    title: 'Authorize a wallet',
    subtitle: 'Connect the wallet that will manage withdrawals for your account.',
  },
  claim: {
    eyebrow: 'Network rewards',
    title: 'Rewards dashboard',
    subtitle: 'Buyer rewards and staking now live in the ANTS dashboard.',
  },
  'close-channel': {
    eyebrow: 'Payment channel',
    title: 'Close channel',
    subtitle: 'Settle this channel and return its unused reserve to your balance.',
  },
};

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4.5" y="10" width="15" height="10.5" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M8 10V7.5a4 4 0 0 1 8 0V10" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/**
 * Standalone checkout page: no sidebar, no tabs — just the one action that
 * needs an external wallet signature. Everything else lives in the desktop
 * app (or the CLI); the browser is only opened to sign.
 */
export function PayPage({ action, amount: amountParam, channelId, popup, config, balance, buyerEvmAddress, refreshBalance }: PayPageProps) {
  const [rewardsError, setRewardsError] = useState<string | null>(null);
  const [openingRewards, setOpeningRewards] = useState(false);
  const openRewards = async () => {
    setOpeningRewards(true); setRewardsError(null);
    try { await openRewardsDashboard(); }
    catch (error) { setRewardsError(error instanceof Error ? error.message : String(error)); }
    finally { setOpeningRewards(false); }
  };
  const [done, setDone] = useState(false);
  const [doneTxHash, setDoneTxHash] = useState<string | null>(null);
  const [amount, setAmount] = useState(() =>
    amountParam && Number(amountParam) > 0 ? amountParam : action === 'deposit' ? '10' : '');
  const { requireAuthorization, operatorSet } = useAuthorizedWallet();

  // Withdraw defaults to the full available balance once it loads.
  useEffect(() => {
    if (action !== 'withdraw' || amount !== '' || !balance?.available) return;
    const available = Number(balance.available);
    if (Number.isFinite(available) && available > 0) setAmount(balance.available);
  }, [action, amount, balance]);

  const handleDeposited = useCallback(async (txHash: string | null) => {
    setDoneTxHash(txHash);
    setDone(true);
    await refreshBalance();
  }, [refreshBalance]);

  // The authorize action has no inline pane — the shared modal handles it.
  useEffect(() => {
    if (action === 'authorize' && operatorSet === false) {
      requireAuthorization(() => setDone(true));
    }
    if (action === 'authorize' && operatorSet === true) {
      setDone(true);
    }
  }, [action, operatorSet, requireAuthorization]);

  // In popup modes, close the window automatically once the payment lands —
  // the app already reflects the new balance. Electron allows window.close()
  // for any window; Chrome app-mode windows allow it while the window has a
  // single history entry (our case: opened directly on this page).
  useEffect(() => {
    if (!popup || !done) return undefined;
    const timer = window.setTimeout(() => window.close(), 3000);
    return () => window.clearTimeout(timer);
  }, [popup, done]);

  // Signal the desktop app so it can pull its window back to the front and
  // refresh balances immediately (closing a Chrome app-mode window otherwise
  // hands focus to whatever window the OS picks).
  useEffect(() => {
    if (!done) return;
    void notifyPaymentCompleted().catch(() => {});
  }, [done]);

  const copy = COPY[action];
  const explorerUrl = doneTxHash ? getExplorerTxUrl(doneTxHash, config?.evmChainId) : null;
  // Only the Electron fallback popup lacks extension wallets (MetaMask, …) —
  // offer the same session in the system browser there. In 'app' mode the
  // page already runs in the user's real browser profile.
  const browserUrl = (() => {
    if (popup !== 'win') return null;
    const url = new URL(window.location.href);
    url.searchParams.delete('popup');
    return url.toString();
  })();

  return (
    <div className="pay-checkout">
      <header className="pay-checkout-topbar">
        <span className="pay-checkout-brand">AntSeed</span>
        <span className="pay-checkout-secure">
          <LockIcon />
          Secure checkout
        </span>
      </header>

      <main className="pay-checkout-main">
        <div className="pay-checkout-card">
          <div className="pay-checkout-summary">
            <span className="pay-checkout-eyebrow">{copy.eyebrow}</span>
            {action === 'deposit' || action === 'withdraw' ? (
              <div className="pay-checkout-amount">
                <span className="pay-checkout-amount-cur" aria-hidden="true">$</span>
                <input
                  className="pay-checkout-amount-input"
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  placeholder="0"
                  size={Math.max(amount.length, 1)}
                  aria-label="Amount in USDC"
                  disabled={done}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                />
                <span className="pay-checkout-amount-unit">USDC</span>
              </div>
            ) : (
              <h1 className="pay-checkout-title">{copy.title}</h1>
            )}
            <dl className="pay-checkout-facts">
              <div className="pay-checkout-fact">
                <dt>Network</dt>
                <dd>
                  <span className="pay-checkout-chip">Base</span>
                </dd>
              </div>
              {action === 'deposit' && (
                <div className="pay-checkout-fact">
                  <dt>Credited to</dt>
                  <dd>{buyerEvmAddress ? <code>{truncateAddress(buyerEvmAddress)}</code> : '—'}</dd>
                </div>
              )}
              {action === 'claim' && (
                <div className="pay-checkout-fact">
                  <dt>Account</dt>
                  <dd>{buyerEvmAddress ? <code>{truncateAddress(buyerEvmAddress)}</code> : '—'}</dd>
                </div>
              )}
              {action === 'close-channel' && channelId && (
                <div className="pay-checkout-fact">
                  <dt>Channel</dt>
                  <dd><code>{truncateAddress(channelId)}</code></dd>
                </div>
              )}
              {action === 'withdraw' && (
                <div className="pay-checkout-fact">
                  <dt>Available</dt>
                  <dd>${balance?.available ?? '—'}</dd>
                </div>
              )}
              {(action === 'deposit' || action === 'withdraw') && (
                <div className="pay-checkout-fact">
                  <dt>Rate</dt>
                  <dd>1 credit = 1 USDC</dd>
                </div>
              )}
            </dl>
          </div>

          <div className="pay-checkout-divider" role="presentation" />

          <div className="pay-checkout-action">
            {done ? (
              <div className="pay-checkout-done" role="status">
                <div className="pay-checkout-done-icon" aria-hidden="true">
                  <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
                    <circle cx="22" cy="22" r="20.5" stroke="currentColor" strokeWidth="2" />
                    <path d="M14 22.5l5.5 5.5 11-12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </svg>
                </div>
                <h2>
                  {action === 'deposit' ? 'Payment complete'
                    : action === 'withdraw' ? 'Withdrawal sent'
                      : action === 'claim' ? 'Rewards claimed'
                        : action === 'close-channel' ? 'Channel updated'
                          : 'Wallet authorized'}
                </h2>
                <p>
                  {popup
                    ? 'Your credits are updating in the app. This window closes automatically.'
                    : 'Your credits are updating in the app. You can close this window.'}
                </p>
                {explorerUrl && (
                  <a className="pay-checkout-txlink" href={explorerUrl} target="_blank" rel="noopener noreferrer">
                    View transaction ↗
                  </a>
                )}
                {popup ? (
                  <Button onClick={() => window.close()}>Close now</Button>
                ) : action === 'deposit' ? (
                  <Button variant="outline" onClick={() => { setDone(false); setDoneTxHash(null); }}>
                    Make another payment
                  </Button>
                ) : null}
              </div>
            ) : (
              <>
                {action === 'deposit' && (
                  <PayCheckoutDeposit
                    config={config}
                    balance={balance}
                    buyerAddress={buyerEvmAddress}
                    amount={amount}
                    onDeposited={handleDeposited}
                  />
                )}
                {action === 'withdraw' && (
                  <PayCheckoutWithdraw
                    config={config}
                    balance={balance}
                    amount={amount}
                    onWithdrawn={handleDeposited}
                  />
                )}
                {action === 'claim' && (
                  <>
                    <p className="pay-checkout-subtitle">{copy.subtitle}</p>
                    <Button disabled={openingRewards} onClick={() => void openRewards()}>{openingRewards ? 'Opening…' : 'Open rewards dashboard ↗'}</Button>
                    {rewardsError ? <p role="alert">{rewardsError}</p> : null}
                  </>
                )}
                {action === 'close-channel' && (
                  <>
                    <p className="pay-checkout-subtitle">{copy.subtitle}</p>
                    <PayChannelClose config={config} channelId={channelId} onDone={handleDeposited} />
                  </>
                )}
                {action === 'authorize' && (
                  <>
                    <p className="pay-checkout-subtitle">{copy.subtitle}</p>
                    <div className="pay-checkout-authorize">
                      <Button onClick={() => requireAuthorization(() => setDone(true))}>
                        Authorize wallet
                      </Button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        <ul className="pay-checkout-trust">
          <li>Non-custodial — funds go to AntSeed's on-chain escrow contract, never to a company account.</li>
          <li>Withdraw unused credits back to your wallet at any time.</li>
          <li>Runs on Base — low fees, settles in seconds.</li>
        </ul>

        {popup === 'app' && !done && (
          <p className="pay-checkout-popup-note">
            This secure window hides browser toolbars, so extension icons aren't visible —
            wallets like MetaMask are still active and will pop up when you connect.
          </p>
        )}

        {browserUrl && !done && (
          <a className="pay-checkout-browser-link" href={browserUrl} target="_blank" rel="noopener noreferrer">
            Using a browser-extension wallet like MetaMask? Open this page in your browser ↗
          </a>
        )}
      </main>

      <footer className="pay-checkout-footer">
        Opened by your AntSeed app · antseed.com
      </footer>
    </div>
  );
}
