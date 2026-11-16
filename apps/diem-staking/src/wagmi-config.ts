import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import {
  coinbaseWallet,
  metaMaskWallet,
  rabbyWallet,
  walletConnectWallet,
  rainbowWallet,
  phantomWallet,
  trustWallet,
  zerionWallet,
  braveWallet,
  ledgerWallet,
  safeWallet,
  injectedWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { createConfig, http, fallback } from 'wagmi';

import { DIEM_CHAIN } from './lib/network';

const projectId = '9a1851410cb5589bc351a6dabf17140e';

const connectors = connectorsForWallets(
  [
    {
      groupName: 'Popular',
      wallets: [
        metaMaskWallet,
        coinbaseWallet,
        rabbyWallet,
        walletConnectWallet,
        phantomWallet,
      ],
    },
    {
      groupName: 'More',
      wallets: [
        rainbowWallet,
        trustWallet,
        zerionWallet,
        braveWallet,
        ledgerWallet,
        safeWallet,
        injectedWallet,
      ],
    },
  ],
  {
    appName: 'Antseed DIEM Capacity',
    projectId,
  },
);

// Mirror of `apps/payments/web/src/wagmi-config.ts` (same WalletConnect project
// + RPC fallback order benchmarked there). If this list drifts, update both
// — a shared `packages/wallet-config` is the next step if a third app adopts it.
export const wagmiConfig = createConfig({
  connectors,
  chains: [DIEM_CHAIN],
  transports: {
    [DIEM_CHAIN.id]: fallback([
      http('https://base-rpc.publicnode.com'),
      http('https://base.gateway.tenderly.co'),
      http('https://base-public.nodies.app'),
    ]),
  },
});
