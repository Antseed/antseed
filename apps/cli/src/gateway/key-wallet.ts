/**
 * What `GET /v1/key`, `/v1/key/rewards` and `/v1/key/savings` report about
 * the wallet paying for a key: its deposits and what its channels hold signed
 * but unsettled (both from the buyer's `GET /_antseed/balances`; the buyer
 * works out the pending spend from the chain records it keeps), its buyer
 * rewards on the gateway's chain, and retail prices for the savings. Every
 * app on a key, Antseed Desktop included, reads these here rather than from
 * the chain or a buyer of its own.
 */
import { formatAntsExact, resolveAntsChain, type AntsChainConfig } from '@antseed/ants'
import { Contract } from 'ethers'
import type { RetailPriceMap } from '@antseed/node/retail-prices'
import { ChainReadCache } from '../proxy/chain-read-cache.js'
import { buyerFetch } from './buyer-control.js'
import { createRewardsReader, gatewayChainProvider, REWARDS_TTL_MS } from './console-api/handlers/wallet-chain.js'
import { baseUnitsToUsdc, decimalUsdc, mapBalances, record } from './console-api/handlers/wallet-mapping.js'
import type { KeyRewards, KeyWalletBalance } from './server.js'

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
 * For a buyer that predates reporting its pending spend: signed minus the
 * store's settled amount on the rows its store calls open (`GET
 * /_antseed/channels`), in base units. The chain is not read, so a channel a
 * seller settled still counts (the balance errs low), and one the buyer gave
 * up on counts nothing.
 */
function storePendingSpend(channelsBody: unknown): bigint {
  const rows = record(channelsBody)['channels']
  if (!Array.isArray(rows)) return 0n
  let total = 0n
  for (const raw of rows) {
    const row = record(raw)
    if (!OPEN_STATUSES.has(text(row['status']))) continue
    const signed = baseUnits(row['cumulativeSigned'])
    const settled = baseUnits(row['settledAmount'])
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
  readRewards?: ReturnType<typeof createRewardsReader>
  transfersEnabled?: (chain: AntsChainConfig) => Promise<boolean>
  now?: () => number
}

export function createKeyWalletReader(options: KeyWalletReaderOptions) {
  const now = options.now ?? Date.now
  const resolveChain = options.resolveChain ?? (() => resolveAntsChain(options.configPath))
  const readRewards = options.readRewards ?? createRewardsReader()
  const transfersEnabled = options.transfersEnabled ?? (async (chain: AntsChainConfig) => {
    if (!chain.antsTokenAddress) return false
    const token = new Contract(chain.antsTokenAddress, ['function transfersEnabled() view returns (bool)'], gatewayChainProvider(chain) as never)
    return Boolean(await token.getFunction('transfersEnabled')())
  })
  const cache = new ChainReadCache({ now, errorRetryMs: 30_000 })
  // For a buyer that predates reporting pending spend: the last figure read
  // per identity, served (as stale) when its channel list fails, since zero
  // would count signed spend as still owned.
  const lastPending = new Map<string, bigint>()
  let prices: { at: number; value: RetailPriceMap | null } | null = null

  async function buyerJson(path: string, identity: string): Promise<unknown | null> {
    const response = await buyerFetch({ buyerPort: options.buyerPort, secret: options.secret, timeoutMs: 3_000 }, path, { identity })
    return response.ok ? response.json() : null
  }

  return {
    /** The wallet's deposits; null when the buyer can't say. */
    async balance(identity: string, { fresh = false }: { fresh?: boolean } = {}): Promise<KeyWalletBalance | null> {
      const body = await buyerJson(`/_antseed/balances${fresh ? '?fresh=1' : ''}`, identity)
      if (!body) return null
      const balances = mapBalances(body)
      const raw = record(body)
      // The buyer's own figure, from the chain records it keeps for every channel.
      let pending = balances.pending ?? null
      let pendingStale = balances.channelsStale === true
      if (pending === null) {
        const channels = await buyerJson('/_antseed/channels', identity).catch(() => null)
        if (channels) {
          const spent = storePendingSpend(channels)
          lastPending.set(identity, spent)
          pending = baseUnitsToUsdc(spent)
        } else {
          const last = lastPending.get(identity)
          // Never read: what this wallet has signed away is unknown, so its balance is too.
          if (last === undefined) return null
          pending = baseUnitsToUsdc(last)
          pendingStale = true
        }
      }
      return {
        available: balances.available,
        reserved: balances.reserved,
        pending: decimalUsdc(pending),
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
