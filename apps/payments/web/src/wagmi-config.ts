import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { base, baseSepolia } from 'wagmi/chains';
import { defineChain, http, fallback } from 'viem';

// Fallback order was picked via a benchmark of the 3-concurrent-eth_call
// pattern that broke the desktop credits pill (getBuyerBalance +
// getBuyerCreditLimit + getOperator in parallel):
//   publicnode              — 153ms, 3/3 reliable (primary)
//   tenderly public gateway — 161ms, 3/3 reliable
//   nodies public           — 163ms, 3/3 reliable
//
// Explicitly NOT in this list:
//   llamarpc            — 0/3 (missing revert data — the original bug)
//   mainnet.base.org    — 1/3 flaky under concurrent reads
//
// Users with production traffic should override via an Alchemy/Infura
// endpoint. Mirrors the @antseed/node default primary.
export const wagmiConfig = getDefaultConfig({
  appName: 'AntSeed Payments',
  projectId: '9a1851410cb5589bc351a6dabf17140e',
  chains: [base],
  transports: {
    [base.id]: fallback([
      http('https://base-rpc.publicnode.com'),
      http('https://base.gateway.tenderly.co'),
      http('https://base-public.nodies.app'),
    ]),
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
  return getDefaultConfig({ appName: 'AntSeed Payments', projectId: '9a1851410cb5589bc351a6dabf17140e', chains: [chain], transports: { [chain.id]: http() } });
}
