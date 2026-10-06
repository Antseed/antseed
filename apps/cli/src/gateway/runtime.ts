import { DEFAULT_BUYER_IDENTITY, FileIdentityStore, identityFromPrivateKeyHex, resolveChainConfig } from '@antseed/node'
import { Contract, JsonRpcProvider } from 'ethers'
import { loadConfig } from '../config/loader.js'
import { loadBuyerIdentity } from '../buyer-identities/store.js'
import { GatewayAccounting } from './accounting.js'
import { parseBaseUnits, parseUsdToUsdc } from './money.js'
import { GatewayServer, type GatewayTopupOptions } from './server.js'
import { SpendFeedPoller } from './spend-feed.js'
import { GatewayStore } from './store.js'
import { X402Facilitator, type X402Asset } from './x402.js'

const DEFAULT_MAX_PER_REQUEST_USDC = '300000'
// AntseedDeposits takes at least 1 USDC on a first deposit, after the sweep fee.
const DEFAULT_TOPUP_MIN_USD = '2'
const DEFAULT_TOPUP_MAX_USD = '500'

export interface GatewayTopupConfig {
  /** x402 facilitator base URL (serves POST /verify and /settle). */
  facilitatorUrl: string
  /** Authorization header value for the facilitator, if it requires one. */
  facilitatorAuthorization?: string
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
  /** Legacy single key from ANTSEED_TUNNEL_API_KEY, kept as an unlimited default key. */
  environmentApiKey?: string
  /** Accept x402 top-ups into keys' buyer wallets. */
  topup?: GatewayTopupConfig
  onLog?: (message: string) => void
}

export interface GatewayRuntime {
  port: number
  store: GatewayStore
  stop: () => Promise<void>
}

async function readDefaultAddress(dataDir: string): Promise<string | null> {
  try {
    const hex = await new FileIdentityStore(dataDir).load()
    return hex && hex.length === 64 ? identityFromPrivateKeyHex(hex).wallet.address : null
  } catch {
    // e.g. an app-encrypted desktop identity the CLI cannot read.
    return null
  }
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

/** Gateway server + spend feed, shared by `antseed gateway start` and `antseed tunnel start`. */
export async function startGatewayRuntime(options: GatewayRuntimeOptions): Promise<GatewayRuntime> {
  const config = await loadConfig(options.configPath)
  const buyerPort = options.buyerPort ?? config.buyer.proxyPort
  const store = new GatewayStore(options.dataDir)

  try {
    if (options.environmentApiKey) {
      if (options.environmentApiKey.length < 16) throw new Error('ANTSEED_TUNNEL_API_KEY must be at least 16 characters.')
      store.syncEnvironmentKey(options.environmentApiKey)
    }
    if (store.countActiveKeys() === 0) {
      throw new Error('No active API keys. Create one with `antseed gateway key create --label <name>`.')
    }
  } catch (error) {
    store.close()
    throw error
  }

  const addresses = new Map<string, string | null>()
  const identityAddress = async (name: string): Promise<string | null> => {
    if (!addresses.has(name)) {
      const address = name === DEFAULT_BUYER_IDENTITY
        ? await readDefaultAddress(options.dataDir)
        : (await loadBuyerIdentity(options.dataDir, name))?.wallet.address ?? null
      addresses.set(name, address)
    }
    return addresses.get(name) ?? null
  }

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
      facilitator: new X402Facilitator({
        url: options.topup.facilitatorUrl,
        ...(options.topup.facilitatorAuthorization ? { authorization: options.topup.facilitatorAuthorization } : {}),
      }),
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
