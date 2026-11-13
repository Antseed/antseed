import { useState, useEffect, useCallback, useRef } from 'react';
import type { BalanceData, PaymentConfig } from './types';
import { getBalance, getConfig } from './api';
import { AuthorizedWalletProvider } from './context/AuthorizedWalletContext';
import { PayPage, type PayPageAction, type PayPagePopup } from './views/PayPage';

const PAY_ACTIONS = new Set<PayPageAction>(['deposit', 'withdraw', 'authorize', 'claim', 'close-channel', 'share-free-tier']);

/**
 * The portal dashboard is retired — every view lives in the desktop app (or
 * the CLI). This page exists only for the actions that need an external
 * wallet signature, opened by the app as `?page=pay&action=...`.
 */
function parsePayPageFromUrl(): { action: PayPageAction; amount: string | null; channelId: string | null; popup: PayPagePopup } {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('action') ?? '';
  // Legacy compat: old app builds linked portal tabs — map them to the
  // nearest signing action instead of a dead dashboard.
  const tab = params.get('tab') ?? params.get('modal') ?? '';
  // (DIEM staking rewards are claimed on diemantseed.com now, so the old
  // 'diem-rewards' tab folds into the network-rewards claim page.)
  const legacy: PayPageAction | null =
    tab === 'rewards' || tab === 'emissions' || tab === 'diem-rewards' ? 'claim'
      : tab ? 'deposit'
        : null;
  const action = PAY_ACTIONS.has(raw as PayPageAction) ? (raw as PayPageAction) : legacy ?? 'deposit';
  // Set by the desktop app: 'app' = the user's real browser in chromeless
  // app mode (extension wallets available); 'win' = Electron popup fallback
  // (WalletConnect/QR only). Both self-close after payment.
  const popupRaw = params.get('popup');
  const popup: PayPagePopup = popupRaw === 'app' ? 'app' : popupRaw ? 'win' : null;
  const channelRaw = params.get('channel');
  return {
    action,
    amount: params.get('amount'),
    channelId: channelRaw && /^0x[0-9a-fA-F]{64}$/.test(channelRaw) ? channelRaw : null,
    popup,
  };
}

export function App() {
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [config, setConfig] = useState<PaymentConfig | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [payPage] = useState(() => parsePayPageFromUrl());

  useEffect(() => {
    const handler = () => setSessionExpired(true);
    window.addEventListener('antseed:session-expired', handler);
    return () => window.removeEventListener('antseed:session-expired', handler);
  }, []);

  useEffect(() => {
    // The checkout is always light (white payment page), whatever theme the
    // user's system prefers.
    document.documentElement.setAttribute('data-theme', 'light');
  }, []);

  const fetchBalance = useCallback(async () => {
    try {
      const data = await getBalance();
      setBalance(data);
    } catch {
      // Don't spin forever on a failed fetch — keep retrying so a transient
      // network blip self-heals without the user reloading the page.
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => { void fetchBalance(); }, 5000);
    }
  }, []);

  const refreshBalance = useCallback(async () => {
    await fetchBalance();
    setTimeout(fetchBalance, 3000);
  }, [fetchBalance]);

  useEffect(() => {
    void fetchBalance();
    void getConfig().then(setConfig).catch(() => {});
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [fetchBalance]);

  const buyerEvmAddress = config?.evmAddress ?? balance?.evmAddress ?? null;

  return (
    <AuthorizedWalletProvider config={config}>
      <PayPage
        action={payPage.action}
        amount={payPage.amount}
        channelId={payPage.channelId}
        popup={payPage.popup}
        config={config}
        balance={balance}
        buyerEvmAddress={buyerEvmAddress}
        refreshBalance={refreshBalance}
      />
      {sessionExpired && (
        <div className="session-expired-overlay" role="alert">
          <div className="session-expired-card">
            <h2 className="session-expired-title">Session expired</h2>
            <p className="session-expired-subtitle">
              Please reopen this page from the desktop app or CLI to get a new session.
            </p>
          </div>
        </div>
      )}
    </AuthorizedWalletProvider>
  );
}
