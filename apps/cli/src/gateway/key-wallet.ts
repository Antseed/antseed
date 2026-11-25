/**
 * What `GET /v1/key`, `/v1/key/rewards` and `/v1/key/savings` report about
 * the wallet paying for a key: its deposits (from the buyer's cached
 * balances, with what open channels hold signed but unsettled), its buyer
 * rewards on the gateway's chain, and retail prices for the savings. Every
 * app on a key, Antseed Desktop included, reads these here rather than from
 * the chain or a buyer of its own.
 */
import { createHash } from 'node:crypto'
import { formatAntsExact, resolveAntsChain, type AntsChainConfig } from '@antseed/ants'
import { Contract } from 'ethers'
import type { RetailPriceMap } from '@antseed/node/retail-prices'
import { ChainReadCache } from '../proxy/chain-read-cache.js'
import { buyerFetch } from './buyer-control.js'
import { createRewardsReader, gatewayChainProvider, readChannelStates, REWARDS_TTL_MS } from './console-api/handlers/wallet-chain.js'
import { baseUnitsToUsdc, mapBalances, record, type ChannelChainState } from './console-api/handlers/wallet-mapping.js'
import type { KeyRewards, KeyWalletBalance } from './server.js'

const CHANNELS_TTL_MS = 30_000
const PRICES_TTL_MS = 10 * 60_000
const PRICES_RETRY_MS = 60_000
const OPEN_STATUSES = new Set(['active', 'open', 'pending', 'closing', 'close_requested', 'withdrawable'])

const text = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')

function baseUnits(value: unknown): bigint {
  try {
    return /^\d+$/.test(text(value)) ? BigInt(text(value)) : 0n
  } catch {
    return 0n
  }
}

/**
 * Signed but not yet settled on the buyer's open channels, in base units.
 * The chain's settled amount wins where it was read; a channel the chain
 * calls closed holds nothing. Where it couldn't be read the buyer's own
 * settled amount (often none) is used, which overstates what is pending, so
 * the balance shown errs low, never high.
 */
export function pendingSpend(channelsBody: unknown, states: ReadonlyMap<string, ChannelChainState>): bigint {
  const rows = record(channelsBody)['channels']
  if (!Array.isArray(rows)) return 0n
  let total = 0n
  for (const raw of rows) {
    const row = record(raw)
    if (!OPEN_STATUSES.has(text(row['status']))) continue
    const state = states.get(text(row['channelId']))
    if (state && state.status !== 1) continue
    const signed = baseUnits(row['cumulativeSigned'])
    const settled = state ? state.settled : baseUnits(row['settledAmount'])
    if (signed > settled) total += signed - settled
  }
  return total
}

export interface KeyWalletReaderOptions {
  buyerPort: number
  secret: string
  configPath: string
  /** Retail prices; the CLI's comparable-prices source. */
  fetchRetailPrices: () => Promise<RetailPriceMap | null>
  /** Seams for tests. */
  resolveChain?: () => Promise<AntsChainConfig>
  readStates?: (chain: AntsChainConfig, ids: string[], sellers: ReadonlyMap<string, string>) => Promise<Map<string, ChannelChainState>>
  readRewards?: ReturnType<typeof createRewardsReader>
  transfersEnabled?: (chain: AntsChainConfig) => Promise<boolean>
  now?: () => number
}

export function createKeyWalletReader(options: KeyWalletReaderOptions) {
  const now = options.now ?? Date.now
  const resolveChain = options.resolveChain ?? (() => resolveAntsChain(options.configPath))
  const readStates = options.readStates ?? ((chain, ids, sellers) => readChannelStates(chain, ids, sellers))
  const readRewards = options.readRewards ?? createRewardsReader()
  const transfersEnabled = options.transfersEnabled ?? (async (chain: AntsChainConfig) => {
    if (!chain.antsTokenAddress) return false
    const token = new Contract(chain.antsTokenAddress, ['function transfersEnabled() view returns (bool)'], gatewayChainProvider(chain) as never)
    return Boolean(await token.getFunction('transfersEnabled')())
  })
  const cache = new ChainReadCache({ now, errorRetryMs: 30_000 })
  // The last pending spend read per buyer identity, served (as stale) when a
  // channel read fails: zero would count signed spend as still owned.
  const lastPending = new Map<string, bigint>()
  let prices: { at: number; value: RetailPriceMap | null } | null = null

  async function buyerJson(path: string, identity: string): Promise<unknown | null> {
    const response = await buyerFetch({ buyerPort: options.buyerPort, secret: options.secret, timeoutMs: 3_000 }, path, { identity })
    return response.ok ? response.json() : null
  }

  async function channelStates(body: unknown): Promise<Map<string, ChannelChainState>> {
    const rows = record(body)['channels']
    if (!Array.isArray(rows)) return new Map()
    const open = rows.map(record).filter((row) => OPEN_STATUSES.has(text(row['status'])))
    const ids = open.map((row) => text(row['channelId'])).filter(Boolean).sort()
    if (ids.length === 0) return new Map()
    const sellers = new Map(open.map((row) => [text(row['channelId']), text(row['seller'])] as [string, string]).filter(([, seller]) => seller))
    try {
      const key = `channels:${createHash('sha256').update(ids.join(',')).digest('hex')}`
      return (await cache.read(key, { ttlMs: CHANNELS_TTL_MS }, async () => readStates(await resolveChain(), ids, sellers))).value
    } catch {
      return new Map()
    }
  }

  return {
    /** The wallet's deposits; null when the buyer can't say. */
    async balance(identity: string, { fresh = false }: { fresh?: boolean } = {}): Promise<KeyWalletBalance | null> {
      const body = await buyerJson(`/_antseed/balances${fresh ? '?fresh=1' : ''}`, identity)
      if (!body) return null
      const balances = mapBalances(body)
      const channels = await buyerJson('/_antseed/channels', identity).catch(() => null)
      let pending: bigint
      let pendingStale = false
      if (channels) {
        pending = pendingSpend(channels, await channelStates(channels))
        lastPending.set(identity, pending)
      } else {
        const last = lastPending.get(identity)
        // Never read: what this wallet has signed away is unknown, so its balance is too.
        if (last === undefined) return null
        pending = last
        pendingStale = true
      }
      const raw = record(body)
      return {
        available: balances.available,
        reserved: balances.reserved,
        pending: baseUnitsToUsdc(pending),
        // The buyer sends null for a read that failed; mapBalances would make it zero.
        wallet: raw['walletUsdc'] === null || raw['walletUsdc'] === undefined ? null : balances.walletUsdc,
        creditLimit: balances.creditLimit,
        operator: balances.operator,
        stale: raw['stale'] === true || pendingStale,
      }
    },

    /** Buyer rewards for an address on the gateway's chain, cached five minutes. */
    async rewards(address: string): Promise<KeyRewards> {
      const read = await cache.read(`rewards:${address.toLowerCase()}`, { ttlMs: REWARDS_TTL_MS, staleWhileRevalidateMs: REWARDS_TTL_MS }, async () => {
        const chain = await resolveChain()
        if (!chain.emissionsContractAddress && !chain.usageRewardsAddress) {
          return { available: false, pendingAnts: '0', currentEpoch: null, transfersEnabled: false }
        }
        const [view, transfers] = await Promise.all([readRewards(chain, address), transfersEnabled(chain).catch(() => false)])
        return {
          available: true,
          pendingAnts: formatAntsExact(BigInt(view.buyerUsage.total || '0') + BigInt(view.legacy.buyer || '0')),
          currentEpoch: view.currentEpoch ?? null,
          transfersEnabled: transfers,
        }
      })
      return read.value
    },

    /** Retail prices, kept ten minutes (a failed read is retried after one). */
    async retailPrices(): Promise<RetailPriceMap | null> {
      const age = prices ? now() - prices.at : Infinity
      if (prices && age < (prices.value ? PRICES_TTL_MS : PRICES_RETRY_MS)) return prices.value
      const value = await options.fetchRetailPrices().catch(() => null)
      // A refresh that fails keeps the last good prices.
      prices = { at: now(), value: value ?? prices?.value ?? null }
      return prices.value
    },
  }
}
