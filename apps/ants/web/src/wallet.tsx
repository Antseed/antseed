import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { WagmiProvider, useAccount, useWalletClient } from 'wagmi';
import { getDefaultConfig, RainbowKitProvider, ConnectButton, darkTheme } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { defineChain, http } from 'viem';
import { ApiError, request, type DashboardConfig } from './api';
import { invalidateAll } from './data';
import { useJobs } from './jobs';
import { WalletReadinessContext, walletReadiness } from './wallet-readiness';
import { walletFailure } from '../../src/wallet-errors';
import { WalletPromptGate } from './wallet-prompt';
import { WalletResultDelivery } from './wallet-result';
import type { BrowserTransaction } from '../../src/browser-signer';
import '@rainbow-me/rainbowkit/styles.css';

const queries = new QueryClient();
/** Match the dashboard's signal colour; the connect button sits on the dark top bar in both themes. */
const walletTheme = darkTheme({ accentColor: '#1fd87a', accentColorForeground: '#06281a', borderRadius: 'small', fontStack: 'system' });
// The workspace also contains React 19; wagmi declarations resolve that peer. Runtime is deduped by Vite.
const WalletRoot = WagmiProvider as unknown as ComponentType<{ config: ReturnType<typeof getDefaultConfig>; children: ReactNode }>;
export function WalletProvider({ config, children }: { config: DashboardConfig; children: ReactNode }) {
  const wagmi = useMemo(() => getDefaultConfig({
    appName: 'AntSeed Staking', projectId: '9a1851410cb5589bc351a6dabf17140e',
    chains: [defineChain({ id: config.evmChainId, name: config.chainId, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [config.walletRpcUrl ?? (config.evmChainId === 8453 ? 'https://mainnet.base.org' : config.evmChainId === 84532 ? 'https://sepolia.base.org' : 'http://127.0.0.1:8545')] } } })],
    transports: { [config.evmChainId]: http() },
  }), [config.chainId, config.evmChainId, config.walletRpcUrl]);
  if (!config.browserWallet) return <>{children}</>;
  return <WalletRoot config={wagmi}><QueryClientProvider client={queries}><RainbowKitProvider theme={walletTheme}><WalletSession config={config}>{children}</WalletSession></RainbowKitProvider></QueryClientProvider></WalletRoot>;
}

function WalletSession({ config, children }: { config: DashboardConfig; children: ReactNode }) {
  const account = useAccount();
  const { data: wallet } = useWalletClient();
  const readiness = walletReadiness(config, { status: account.status, address: account.address, chainId: account.chainId, clientAddress: wallet?.account.address, clientChainId: wallet?.chain.id });
  const current = useRef(readiness);
  current.current = readiness;
  const assertReady = useCallback(() => { if (current.current.reason) throw new Error(current.current.reason); }, []);
  return <WalletReadinessContext.Provider value={{ ...readiness, assertReady }}>{children}</WalletReadinessContext.Provider>;
}

/** Sync wallet identity before enabling jobs. Every transaction has an explicit wallet approval. */
export function WalletControls({ config }: { config: DashboardConfig }) {
  const account = useAccount();
  const { jobs, running, locallyStartedJobIds, pushToast, titleForJob } = useJobs();
  const { data: wallet } = useWalletClient();
  const [pending, setPending] = useState<BrowserTransaction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const processing = useRef(false);
  const promptGate = useRef(new WalletPromptGate());
  const announced = useRef(new Map<string, string>());
  const syncedIdentity = useRef<string | null>(null);
  const syncQueue = useRef<Promise<void>>(Promise.resolve());
  const delivery = useRef(new WalletResultDelivery(result => request('/api/wallet/result', { method: 'POST', body: result })));
  const transactionActive = useRef(false);
  transactionActive.current = running || busy || pending !== null;
  const wrongChain = !!account.address && account.chainId !== config.evmChainId;
  const settling = account.status === 'connecting' || account.status === 'reconnecting';
  useEffect(() => {
    if (error) pushToast({ tone: 'danger', title: 'Wallet request failed', body: error, sticky: true });
  }, [error, pushToast]);
  useEffect(() => {
    // Wait for wagmi to settle; a transient wallet-less state must not be reported as a disconnect.
    if (settling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const identity = `${account.address?.toLowerCase() ?? ''}:${account.chainId ?? ''}`;
    // Only a tab that previously synced a wallet may clear the server's signer.
    const hadWallet = !!syncedIdentity.current && !syncedIdentity.current.startsWith(':');
    let queued = false;
    function sync(refresh = false) {
      if (queued || stopped) return;
      queued = true;
      // Serialize account updates so a slow request for the previous wallet cannot win.
      syncQueue.current = syncQueue.current.catch(() => {}).then(async () => {
        if (stopped) return;
        try {
          const refreshAccount = refresh && !wrongChain;
          const disconnect = wrongChain || (!account.address && hadWallet);
          const result = await request<{ changed?: boolean }>('/api/wallet', { method: 'POST', body: { address: wrongChain ? undefined : account.address, chainId: account.chainId, refresh: refreshAccount, disconnect } });
          if (!stopped) {
            const changed = result.changed ?? (syncedIdentity.current !== identity);
            syncedIdentity.current = identity;
            setError(null);
            if (changed || refreshAccount) invalidateAll({ clear: changed });
          }
        } catch (e) {
          if (!stopped) {
            setError(e instanceof Error ? e.message : String(e));
            if (config.selectedAddress && e instanceof ApiError && e.status === 400) invalidateAll();
            else timer = setTimeout(() => sync(refresh), 1500);
          }
        } finally { queued = false; }
      });
    }
    void sync();
    const onFocus = () => { if (!transactionActive.current) void sync(true); };
    window.addEventListener('focus', onFocus);
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener('focus', onFocus); };
  }, [account.address, account.chainId, wrongChain, settling, config.selectedAddress]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await request<BrowserTransaction | null>('/api/wallet/request');
        if (!stopped) {
          setPending(next);
          await delivery.current.deliver(next?.id ?? null);
        }
      }
      catch { /* Normal API surfaces handle server errors. */ }
      finally {
        // Keep slow idle discovery for actions from another tab; active jobs poll promptly.
        if (!stopped) timer = setTimeout(() => void poll(), running || pending !== null ? 1000 : 30_000);
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [running, pending !== null]);
  useEffect(() => {
    if (!pending?.jobId) return;
    const job = jobs.find(item => item.id === pending.jobId);
    if (!job || job.status !== 'running') return;
    const stage = pending.submittedHash ? 'Submitted' : 'Awaiting wallet approval';
    if (announced.current.get(pending.id) === stage) return;
    if (announced.current.get(pending.id) === 'Submitted') return;
    announced.current.set(pending.id, stage);
    pushToast({ tone: 'info', jobId: pending.jobId, title: `${titleForJob(pending.jobId)} · ${stage}`, body: pending.submittedHash ? 'Waiting for on-chain confirmation.' : 'No transaction has been submitted yet.', hash: pending.submittedHash, sticky: true });
  }, [pending, jobs, pushToast, titleForJob]);
  const approve = useCallback(async () => {
    if (!pending || !wallet || processing.current || pending.submittedHash) return;
    processing.current = true; setBusy(true); setError(null);
    let startedHere = false;
    try {
      if (wallet.account.address.toLowerCase() !== pending.from.toLowerCase() || account.address?.toLowerCase() !== pending.from.toLowerCase() || account.chainId !== pending.chainId || wallet.chain.id !== pending.chainId || config.evmChainId !== pending.chainId) throw new Error('Connect the wallet and network shown in this request.');
      await request('/api/wallet/begin', { method: 'POST', body: { id: pending.id } });
      startedHere = true;
      const hash = await wallet.sendTransaction({ account: wallet.account, chain: wallet.chain, to: pending.to as `0x${string}`, data: pending.data as `0x${string}`, value: BigInt(pending.value) });
      delivery.current.enqueue({ id: pending.id, hash });
      announced.current.set(pending.id, 'Submitted');
      pushToast({ tone: 'info', jobId: pending.jobId, title: `${titleForJob(pending.jobId ?? '')} · Submitted`, body: 'Waiting for on-chain confirmation.', hash, sticky: true });
      await delivery.current.deliver(pending.id);
    } catch (e) {
      const message = walletFailure(e);
      if (startedHere) {
        delivery.current.enqueue({ id: pending.id, error: message });
        await delivery.current.deliver(pending.id);
      } else setError(message);
    } finally { processing.current = false; setBusy(false); }
  }, [pending, wallet, account.address, account.chainId, config.evmChainId, pushToast, titleForJob]);
  const promptContext = useMemo(() => ({ transaction: pending, locallyStartedJobIds, accountAddress: account.address, accountChainId: account.chainId, walletAddress: wallet?.account.address, walletChainId: wallet?.chain.id, expectedChainId: config.evmChainId, busy, settling }), [pending, locallyStartedJobIds, account.address, account.chainId, wallet, config.evmChainId, busy, settling]);
  useEffect(() => {
    if (promptGate.current.claim(promptContext)) void approve();
  }, [promptContext, approve]);
  return <div className="browser-wallet">
    <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
    {wrongChain && <span className="hint">Switch to {config.chainId} to continue.</span>}
  </div>;
}

/** Buyer reward setup uses the same wallet connection as the header. */
export function BuyerWalletAction() {
  return <ConnectButton.Custom>{({ account, chain, openConnectModal, openAccountModal, openChainModal, mounted }) => (
    <button className="btn" disabled={!mounted} onClick={!account ? openConnectModal : chain?.unsupported ? openChainModal : openAccountModal}>
      {!account ? 'Connect wallet' : chain?.unsupported ? 'Switch network' : 'Change wallet'}
    </button>
  )}</ConnectButton.Custom>;
}
