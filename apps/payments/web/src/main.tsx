import type { ComponentType, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { WagmiProvider, type Config } from 'wagmi';
import { RainbowKitProvider } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { wagmiConfig, paymentWalletConfig } from './wagmi-config';
import { App } from './App';
import { getConfig } from './api';
import '@rainbow-me/rainbowkit/styles.css';
import '@antseed/ui/styles';
import './styles/global.scss';

const queryClient = new QueryClient();
// Runtime React is deduped; wagmi's workspace peer declarations also include React 19.
const WalletRoot = WagmiProvider as unknown as ComponentType<{ config: Config; children: ReactNode }>;

const root = document.getElementById('root')!;
async function start() {
  let walletConfig: Config = wagmiConfig;
  try { walletConfig = paymentWalletConfig(await getConfig()); } catch { /* App displays configuration/session failures. */ }
  createRoot(root).render(
    <WalletRoot config={walletConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          <App />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WalletRoot>
  );

}
void start();
