import { loadConfig } from '../config/loader.js'
import { GatewayAccounting } from './accounting.js'
import { readIdentityAddress } from './identities.js'
import { parseBaseUnits } from './money.js'
import { GatewayServer } from './server.js'
import { SpendFeedPoller } from './spend-feed.js'
import { DEFAULT_IDENTITY_ID, GatewayStore, type GatewayIdentity } from './store.js'
import { BuyerSupervisor } from './supervisor.js'

const DEFAULT_MAX_PER_REQUEST_USDC = '300000'
const SUPERVISOR_SYNC_INTERVAL_MS = 10_000

export interface GatewayRuntimeOptions {
  dataDir: string
  configPath: string
  listenPort: number
  listenHost?: string
  /** Buyer port of the default identity; defaults to the config's buyer.proxyPort. */
  defaultBuyerPort?: number
  /** Legacy single key from ANTSEED_TUNNEL_API_KEY, kept as an unlimited default key. */
  environmentApiKey?: string
  onLog?: (message: string) => void
}

export interface GatewayRuntime {
  port: number
  store: GatewayStore
  stop: () => Promise<void>
}

/**
 * Gateway server + spend feed + supervised identity buyers, shared by
 * `antseed gateway start` and `antseed tunnel start`.
 */
export async function startGatewayRuntime(options: GatewayRuntimeOptions): Promise<GatewayRuntime> {
  const config = await loadConfig(options.configPath)
  const defaultBuyerPort = options.defaultBuyerPort ?? config.buyer.proxyPort
  const store = new GatewayStore(options.dataDir)

  try {
    if (options.environmentApiKey) {
      if (options.environmentApiKey.length < 16) throw new Error('ANTSEED_TUNNEL_API_KEY must be at least 16 characters.')
      store.syncEnvironmentKey(options.environmentApiKey)
    }
    if (store.countActiveKeys() === 0) {
      throw new Error('No active API keys. Create one with `antseed gateway key create --label <name>`.')
    }
    const defaultAddress = await readIdentityAddress(options.dataDir)
    if (defaultAddress) store.setIdentityAddress(DEFAULT_IDENTITY_ID, defaultAddress)
  } catch (error) {
    store.close()
    throw error
  }

  const resolveBuyerPort = (identity: GatewayIdentity): number | null =>
    identity.id === DEFAULT_IDENTITY_ID ? defaultBuyerPort : identity.buyerPort
  const servedIdentities = (): GatewayIdentity[] => {
    const active = store.identitiesWithActiveKeys()
    return store.listIdentities().filter((identity) => active.has(identity.id))
  }

  const accounting = new GatewayAccounting(store, {
    holdUsdc: parseBaseUnits(config.payments?.maxPerRequestUsdc ?? DEFAULT_MAX_PER_REQUEST_USDC),
  })
  const spendFeed = new SpendFeedPoller({
    targets: () => servedIdentities().flatMap((identity) => {
      const port = resolveBuyerPort(identity)
      return port === null ? [] : [{ identityId: identity.id, port }]
    }),
    onPage: (identityId, page) => {
      const recorded = accounting.ingest(identityId, page.bootId, page.events)
      if (recorded > 0) options.onLog?.(`recorded ${recorded} spend event(s) for ${identityId}`)
    },
    onLog: options.onLog,
  })
  const supervisor = new BuyerSupervisor({ configPath: options.configPath, onLog: options.onLog })
  const server = new GatewayServer({
    store,
    accounting,
    resolveBuyerPort,
    spendFeedState: (identityId) => spendFeed.state(identityId),
    refreshSpendFeed: () => spendFeed.pollOnce(),
    listenPort: options.listenPort,
    listenHost: options.listenHost,
    onLog: options.onLog,
  })

  const syncSupervisor = () => supervisor.sync(servedIdentities()).catch((error: unknown) => {
    options.onLog?.(`identity buyer sync failed: ${error instanceof Error ? error.message : String(error)}`)
  })

  let port: number
  try {
    port = await server.start()
  } catch (error) {
    store.close()
    throw error
  }
  await syncSupervisor()
  spendFeed.start()
  // Picks up identities whose first key was created while the gateway runs.
  const syncTimer = setInterval(() => void syncSupervisor(), SUPERVISOR_SYNC_INTERVAL_MS)
  syncTimer.unref?.()

  return {
    port,
    store,
    stop: async () => {
      clearInterval(syncTimer)
      await server.stop()
      await spendFeed.stop()
      await supervisor.stop()
      accounting.dispose()
      store.close()
    },
  }
}
