import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import {
  braveWallet,
  coinbaseWallet,
  injectedWallet,
  ledgerWallet,
  metaMaskWallet,
  phantomWallet,
  rabbyWallet,
  rainbowWallet,
  safeWallet,
  trustWallet,
  walletConnectWallet,
  zerionWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { createConfig, fallback, http } from 'wagmi';
import { CHAIN, RPC_URLS } from './lib/chain';

// Same WalletConnect project as apps/diem-staking and apps/payments.
const projectId = '9a1851410cb5589bc351a6dabf17140e';

const connectors = connectorsForWallets(
  [
    { groupName: 'Popular', wallets: [metaMaskWallet, coinbaseWallet, rabbyWallet, walletConnectWallet, phantomWallet] },
    { groupName: 'More', wallets: [rainbowWallet, trustWallet, zerionWallet, braveWallet, ledgerWallet, safeWallet, injectedWallet] },
  ],
  { appName: 'Antseed Points', projectId },
);

export const wagmiConfig = createConfig({
  connectors,
  chains: [CHAIN],
  transports: { [CHAIN.id]: fallback(RPC_URLS.map((url) => http(url))) },
});
