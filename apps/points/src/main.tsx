import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider, lightTheme } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import './styles.css';
import { App } from './App';
import { AddressProvider } from './lib/address';
import { wagmiConfig } from './wagmi-config';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 2, refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={lightTheme({ accentColor: '#001E12', accentColorForeground: '#ffffff', borderRadius: 'large', fontStack: 'system' })} modalSize="compact">
          <AddressProvider>
            <App />
          </AddressProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
