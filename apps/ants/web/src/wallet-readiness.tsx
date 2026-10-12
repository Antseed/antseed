import { createContext, useContext } from 'react';
import type { DashboardConfig } from './api';

export interface WalletReadiness {
  reason?: string;
  label?: string;
  assertReady: () => void;
}

export const WalletReadinessContext = createContext<WalletReadiness | null>(null);
export const useWalletReadiness = () => useContext(WalletReadinessContext);

export interface WalletConnection {
  status: string;
  address?: string;
  chainId?: number;
  clientAddress?: string;
  clientChainId?: number;
}

export function walletReadiness(config: DashboardConfig, connection: WalletConnection): Omit<WalletReadiness, 'assertReady'> {
  if (!config.browserWallet) return {};
  if (connection.status === 'connecting' || connection.status === 'reconnecting') return { label: 'Connecting wallet…', reason: 'Wait for the wallet connection to finish.' };
  if (connection.status !== 'connected' || !connection.address) return { label: 'Connect wallet', reason: 'Connect wallet before submitting a transaction.' };
  if (connection.chainId !== config.evmChainId) return { label: 'Switch network', reason: `Switch your wallet to ${config.chainId}.` };
  if (config.readOnly || connection.address.toLowerCase() !== config.walletAddress?.toLowerCase()) return { label: 'Waiting for wallet sync…', reason: 'Wait for the connected wallet to sync with the dashboard.' };
  if (connection.clientAddress?.toLowerCase() !== connection.address.toLowerCase() || connection.clientChainId !== config.evmChainId) return { label: 'Waiting for wallet…', reason: 'The connected wallet is not ready to sign yet.' };
  return {};
}
