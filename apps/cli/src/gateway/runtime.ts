import { resolveChainConfig } from '@antseed/node'
import { Contract } from 'ethers'
import { resolveBaseRpcUrlOverride } from '../cli/payment-utils.js'
import { sharedChainProvider } from '../proxy/chain-rpc.js'
import { loadConfig } from '../config/loader.js'
import { GatewayAccounting } from './accounting.js'
import { loadOrCreateControlSecret } from './buyer-control.js'
import { BuyerPolicyProbe } from './buyer-policy-probe.js'
import { parseBaseUnits, parseUsdToUsdc } from './money.js'
import { GatewayServer, type GatewayServerOptions, type GatewayTopupOptions } from './server.js'
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
  /**
   * Builds the console handler (`/console`) once the store exists. With a
   * console the gateway also starts without any keys, so the owner can
   * claim it and create the first one there.
   */
  createConsole?: (context: GatewayConsoleContext) => GatewayConsoleHandle | null
}

/** What `createConsole` returns: the request handler plus start-up hooks. */
export interface GatewayConsoleHandle extends NonNullable<GatewayServerOptions['console']> {
  /** Called once the gateway listens, with the bound port. */
  listening?(port: number): void
  /** A fresh single-use owner setup link while the console is unclaimed; null once it has an owner. */
  setupLink?(): string | null
}

export interface GatewayConsoleContext {
  store: GatewayStore
  buyerPort: number
  controlSecret: string
  spendFeedState: () => string
  x402Enabled: boolean
  /** The address the gateway listens on (`--host`), for judging who can reach it. */
  listenHost?: string
}

export interface GatewayRuntime {
  port: number
  store: GatewayStore
  /** The console, when `createConsole` was given. */
  console: GatewayConsoleHandle | null
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
    rpcUrl: resolveBaseRpcUrlOverride() ?? crypto?.rpcUrl,
    usdcContractAddress: crypto?.usdcContractAddress,
  })
  let asset: Promise<X402Asset> | null = null
  return () => {
    // Read once per process through the shared provider (which fails over between endpoints).
    asset ??= (async () => {
      const token = new Contract(chain.usdcContractAddress, [
        'function name() view returns (string)',
        'function version() view returns (string)',
      ], sharedChainProvider(chain))
      const [name, version] = await Promise.all([token.getFunction('name')(), token.getFunction('version')()]) as [string, string]
      return { network: `eip155:${chain.evmChainId}`, chainId: chain.evmChainId, address: chain.usdcContractAddress, name, version }
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

export async function liveBuyerIdentityAddress(buyerPort: number, name: string): Promise<string | null> {
  const response = await fetch(`http://127.0.0.1:${buyerPort}/_antseed/buyer-identities`, {
    signal: AbortSignal.timeout(3_000),
  })
  if (!response.ok) return null
  const body = await response.json() as { identities?: Array<{ name: string; address: string }> }
  return body.identities?.find((identity) => identity.name === name)?.address ?? null
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
    if (store.countActiveKeys() === 0 && !options.createConsole) {
      throw new Error('No active API keys. Create one with `antseed gateway key create --label <name>`.')
    }
  } catch (error) {
    store.close()
    throw error
  }

  const controlSecret = loadOrCreateControlSecret(options.dataDir)
  // Confirm the buyer applies routing policies before trusting it with them;
  // an older buyer would ignore the header and route unrestricted.
  const policyProbe = new BuyerPolicyProbe({ buyerPort, secret: controlSecret, onLog: options.onLog })
  const identityAddress = (name: string): Promise<string | null> => liveBuyerIdentityAddress(buyerPort, name)

  const accounting = new GatewayAccounting(store, {
    holdUsdc: parseBaseUnits(config.payments?.maxPerRequestUsdc ?? DEFAULT_MAX_PER_REQUEST_USDC),
  })
  const spendFeed = new SpendFeedPoller({
    buyerPort,
    controlSecret,
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
  const consoleHandler = options.createConsole?.({
    store,
    buyerPort,
    controlSecret,
    spendFeedState: () => spendFeed.state,
    x402Enabled: Boolean(topup),
    listenHost: options.listenHost ?? '127.0.0.1',
  }) ?? null
  const server = new GatewayServer({
    console: consoleHandler,
    controlSecret,
    buyerPolicyUnsupported: () => policyProbe.policyUnsupported(),
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
    policyProbe.stop()
    accounting.dispose()
    store.close()
    throw error
  }
  spendFeed.start()
  await policyProbe.start()
  consoleHandler?.listening?.(port)

  return {
    port,
    store,
    console: consoleHandler,
    stop: async () => {
      policyProbe.stop()
      await server.stop()
      await spendFeed.stop()
      accounting.dispose()
      store.close()
    },
  }
}
