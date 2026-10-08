import { useMemo, type ComponentType, type ReactNode } from 'react'
import { WagmiProvider, type Config } from 'wagmi'
import { base, baseSepolia } from 'wagmi/chains'
import { darkTheme, getDefaultConfig, lightTheme, RainbowKitProvider } from '@rainbow-me/rainbowkit'
import { defineChain, http, type Chain } from 'viem'
import type { ChainInfo } from '../api/types'
import { isDarkNow } from '../app/theme'
import '@rainbow-me/rainbowkit/styles.css'

import { ANTSEED_RAINBOWKIT_NEUTRAL } from '@antseed/wallet-config'
import { WALLETCONNECT_PROJECT_ID } from '../config'

function toChain(info: ChainInfo): Chain {
  if (info.chainId === base.id) return info.rpcUrl ? { ...base, rpcUrls: { default: { http: [info.rpcUrl] } } } : base
  if (info.chainId === baseSepolia.id) return info.rpcUrl ? { ...baseSepolia, rpcUrls: { default: { http: [info.rpcUrl] } } } : baseSepolia
  return defineChain({
    id: info.chainId,
    name: info.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [info.rpcUrl] } },
    blockExplorers: info.explorerUrl ? { default: { name: 'Explorer', url: info.explorerUrl } } : undefined,
  })
}

const configs = new Map<string, Config>()

/** One wagmi config per chain, reused across mounts so the wallet connection survives page changes. */
function configFor(info: ChainInfo | null): Config {
  const key = info ? `${info.chainId}:${info.rpcUrl}` : 'signin'
  let config = configs.get(key)
  if (!config) {
    const chains: [Chain, ...Chain[]] = info ? [toChain(info)] : [base, baseSepolia]
    config = getDefaultConfig({
      appName: 'Antseed Console',
      projectId: WALLETCONNECT_PROJECT_ID,
      chains,
      // The browser talks to the chain only for transactions the user starts
      // (and their receipts); balances come from the gateway API. Keep that
      // light on the public RPC: concurrent reads share one Multicall3 call,
      // receipts are polled every 4 s, and retries back off.
      transports: Object.fromEntries(chains.map((chain) => [chain.id, http(undefined, { retryCount: 2, retryDelay: 1_000 })])),
      batch: { multicall: { wait: 16 } },
      pollingInterval: 4_000,
      ssr: false,
    }) as Config
    configs.set(key, config)
  }
  return config
}

// The workspace also contains React 19 types; wagmi's declarations can resolve that peer. Runtime is deduped by Vite.
const WagmiRoot = WagmiProvider as unknown as ComponentType<{ config: Config; children: ReactNode }>
const RainbowRoot = RainbowKitProvider as unknown as ComponentType<{ theme: ReturnType<typeof darkTheme>; children: ReactNode }>

/** Wallet connection for browser-signed actions. Pass the gateway's chain, or null for sign-in only. */
export function WalletProvider({ chain, children }: { chain: ChainInfo | null; children: ReactNode }) {
  const config = useMemo(() => configFor(chain), [chain])
  // Neutral: the accent follows the console's own primary-button tokens.
  const theme = isDarkNow() ? darkTheme(ANTSEED_RAINBOWKIT_NEUTRAL) : lightTheme(ANTSEED_RAINBOWKIT_NEUTRAL)
  return <WagmiRoot config={config}><RainbowRoot theme={theme}>{children}</RainbowRoot></WagmiRoot>
}

export function walletError(error: unknown, fallback = 'The wallet request failed.'): string {
  if (error && typeof error === 'object' && 'shortMessage' in error && typeof error.shortMessage === 'string') return error.shortMessage
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message
  return fallback
}
