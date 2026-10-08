import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { base, baseSepolia } from 'wagmi/chains';
import { defineChain, http, fallback } from 'viem';
import { ANTSEED_WALLETCONNECT_PROJECT_ID, BASE_PUBLIC_RPC_URLS } from '@antseed/wallet-config';

// Benchmarked public Base RPCs in fallback order (see BASE_PUBLIC_RPC_URLS).
// Users with production traffic should override via an Alchemy/Infura endpoint.
export const wagmiConfig = getDefaultConfig({
  appName: 'AntSeed Payments',
  projectId: ANTSEED_WALLETCONNECT_PROJECT_ID,
  chains: [base],
  transports: {
    [base.id]: fallback(BASE_PUBLIC_RPC_URLS.map((url) => http(url))),
  },
});

/** Match authorization/receipt reads to the launching CLI or VPR network. */
export function paymentWalletConfig(config: { evmChainId: number; chainId: string; rpcUrl: string }) {
  if (config.evmChainId === base.id) return wagmiConfig;
  const chain = config.evmChainId === baseSepolia.id ? baseSepolia
    : config.evmChainId === 31337 && /^http:\/\/(127\.0\.0\.1|localhost):[0-9]+\/?$/.test(config.rpcUrl)
      ? defineChain({ id: 31337, name: 'Local Anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } })
      : null;
  if (!chain) throw new Error(`Unsupported wallet network: ${config.chainId}`);
  return getDefaultConfig({ appName: 'AntSeed Payments', projectId: ANTSEED_WALLETCONNECT_PROJECT_ID, chains: [chain], transports: { [chain.id]: http() } });
}
