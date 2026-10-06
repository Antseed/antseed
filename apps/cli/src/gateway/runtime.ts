import { resolveChainConfig } from '@antseed/node'
import { Contract, JsonRpcProvider } from 'ethers'
import { loadConfig } from '../config/loader.js'
import { buyerIdentityAddress } from '../buyer-identities/store.js'
import { GatewayAccounting } from './accounting.js'
import { parseBaseUnits, parseUsdToUsdc } from './money.js'
import { GatewayServer, type GatewayTopupOptions } from './server.js'
import { SpendFeedPoller } from './spend-feed.js'
import { GatewayStore } from './store.js'
import { X402Facilitator, type X402Asset } from './x402.js'
import { cdpAuthorization, type CdpCredentials } from './cdp-auth.js'

const DEFAULT_MAX_PER_REQUEST_USDC = '300000'
// AntseedDeposits takes at least 1 USDC on a first deposit, after the sweep fee.
const DEFAULT_TOPUP_MIN_USD = '2'
const DEFAULT_TOPUP_MAX_USD = '500'

export interface GatewayTopupConfig {
  /** x402 facilitator base URL (serves POST /verify and /settle). */
  facilitatorUrl: string
  /** Fixed Authorization header value, for facilitators that use a static token. */
  facilitatorAuthorization?: string
  /** Coinbase CDP API key; each facilitator call is signed with it. */
  cdp?: CdpCredentials
  minUsd?: string
  maxUsd?: string
}

export interface GatewayRuntimeOptions {
  dataDir: string
  configPath: string
  listenPort: number
  listenHost?: string
  /** Port of the buyer every key is served through; defaults to the config's buyer.proxyPort. */
  buyerPort?: number
  /**
   * Legacy single key from ANTSEED_TUNNEL_API_KEY, kept as an unlimited
   * default key. `null` means the tunnel started without it, which retires
   * the stored key; omit it to leave that key as it is.
   */
  environmentApiKey?: string | null
  /** Accept x402 top-ups into keys' buyer wallets. */
  topup?: GatewayTopupConfig
  onLog?: (message: string) => void
}

export interface GatewayRuntime {
  port: number
  store: GatewayStore
  stop: () => Promise<void>
}

/**
 * The USDC the buyer's chain uses, with the EIP-712 domain its
 * `transferWithAuthorization` signatures are checked against.
 */
function usdcAsset(config: Awaited<ReturnType<typeof loadConfig>>): () => Promise<X402Asset> {
  const crypto = config.payments?.crypto
  const chain = resolveChainConfig({
    chainId: crypto?.chainId,
    rpcUrl: crypto?.rpcUrl,
    usdcContractAddress: crypto?.usdcContractAddress,
  })
  let asset: Promise<X402Asset> | null = null
  return () => {
    asset ??= (async () => {
      let lastError: unknown
      for (const rpcUrl of [chain.rpcUrl, ...(chain.fallbackRpcUrls ?? [])]) {
        try {
          const token = new Contract(chain.usdcContractAddress, [
            'function name() view returns (string)',
            'function version() view returns (string)',
          ], new JsonRpcProvider(rpcUrl, chain.evmChainId, { staticNetwork: true }))
          const [name, version] = await Promise.all([token.getFunction('name')(), token.getFunction('version')()]) as [string, string]
          return { network: `eip155:${chain.evmChainId}`, chainId: chain.evmChainId, address: chain.usdcContractAddress, name, version }
        } catch (error) {
          lastError = error
        }
      }
      throw lastError
    })().catch((error: unknown) => {
      asset = null
      throw error
    })
    return asset
  }
}

function facilitatorAuth(config: GatewayTopupConfig): { authorize?: (endpointUrl: string) => string } {
  const { cdp, facilitatorAuthorization } = config
  if (cdp) return { authorize: (endpointUrl) => cdpAuthorization(cdp, endpointUrl) }
  if (facilitatorAuthorization) return { authorize: () => facilitatorAuthorization }
  return {}
}

/** Gateway server + spend feed, shared by `antseed gateway start` and `antseed tunnel start`. */
export async function startGatewayRuntime(options: GatewayRuntimeOptions): Promise<GatewayRuntime> {
  const config = await loadConfig(options.configPath)
  const buyerPort = options.buyerPort ?? config.buyer.proxyPort
  const store = new GatewayStore(options.dataDir)

  try {
    if (options.environmentApiKey) {
      if (options.environmentApiKey.length < 16) throw new Error('ANTSEED_TUNNEL_API_KEY must be at least 16 characters.')
      store.syncEnvironmentKey(options.environmentApiKey)
    } else if (options.environmentApiKey === null && store.retireEnvironmentKey()) {
      options.onLog?.('ANTSEED_TUNNEL_API_KEY is unset; revoked the key it created')
    }
    if (store.countActiveKeys() === 0) {
      throw new Error('No active API keys. Create one with `antseed gateway key create --label <name>`.')
    }
  } catch (error) {
    store.close()
    throw error
  }

  // Read on every call rather than cached: an identity can be removed and
  // recreated with a new wallet while the gateway runs, and a stale address
  // would send top-ups to the archived wallet.
  const identityAddress = (name: string): Promise<string | null> => buyerIdentityAddress(options.dataDir, name)

  const accounting = new GatewayAccounting(store, {
    holdUsdc: parseBaseUnits(config.payments?.maxPerRequestUsdc ?? DEFAULT_MAX_PER_REQUEST_USDC),
  })
  const spendFeed = new SpendFeedPoller({
    buyerPort,
    onPage: (page) => {
      const recorded = accounting.ingest(page.bootId, page.events)
      if (recorded > 0) options.onLog?.(`recorded ${recorded} spend event(s)`)
    },
    onLog: options.onLog,
  })
  const topup: GatewayTopupOptions | null = options.topup
    ? {
      asset: usdcAsset(config),
      facilitator: new X402Facilitator({ url: options.topup.facilitatorUrl, ...facilitatorAuth(options.topup) }),
      minUsdc: parseUsdToUsdc(options.topup.minUsd ?? DEFAULT_TOPUP_MIN_USD),
      maxUsdc: parseUsdToUsdc(options.topup.maxUsd ?? DEFAULT_TOPUP_MAX_USD),
    }
    : null
  const server = new GatewayServer({
    topup,
    store,
    accounting,
    buyerPort,
    identityAddress,
    spendFeedState: () => spendFeed.state,
    refreshSpendFeed: () => spendFeed.pollOnce(),
    listenPort: options.listenPort,
    listenHost: options.listenHost,
    onLog: options.onLog,
  })

  let port: number
  try {
    port = await server.start()
  } catch (error) {
    accounting.dispose()
    store.close()
    throw error
  }
  spendFeed.start()

  return {
    port,
    store,
    stop: async () => {
      await server.stop()
      await spendFeed.stop()
      accounting.dispose()
      store.close()
    },
  }
}
